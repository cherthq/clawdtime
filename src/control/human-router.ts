import { createHash } from "node:crypto";
import { z } from "zod";
import type { ClawdTime, ResponseInput } from "../attention/service.js";
import type {
  ActionReceipt,
  AgentSession,
  AttentionRequest,
  CallSession,
  ControlLease,
  Frame,
  HumanResponse,
  InputAction,
} from "../contracts.js";
import { actionSchema, ControlCoordinator } from "./coordinator.js";
import {
  ControlPreflightError,
  sanitizeControlPreflightDiagnostics,
  type ToolPreflightDiagnostics,
  type ControlPreflightDiagnostics,
} from "./errors.js";
import type {
  ConversationAgent,
  ConversationTools,
  Observation,
} from "./conversation.js";

/** Legacy single-action planner remains available only to isolated planner tests. */
export interface SingleActionPlanner {
  plan(
    task: string,
    lease: ControlLease,
  ): Promise<{ action: InputAction; frame: Frame }>;
}
export interface HumanResult {
  accepted: boolean;
  reply?: string;
  clarification?: string;
  response?: HumanResponse;
  stopped?: boolean;
  receipt?: ActionReceipt;
  state?: string;
  code?: string;
  diagnostics?: ControlPreflightDiagnostics;
  responseId?: string;
}
/** Literal emergency phrases only; all ordinary intent stays with the conversation agent. */
export const isImmediateStop = (text: string) =>
  /^(?:(?:hey\s+)?clawdtime[,!:]?\s+)?stop(?:\s+(?:sharing|control|listening))?[.!]?$/i.test(
    text.trim(),
  );
const toolFailureReplies: Record<ToolPreflightDiagnostics["reason"], string> = {
  parallel_tools: "I couldn't safely order the requested screen actions.",
  operation_limit: "I reached the screen-check limit for this request.",
  action_invalid: "I couldn't form a valid action for that target.",
  action_limit: "I reached the input limit for this request.",
  observation_missing: "I need to look at the screen before acting.",
  frame_mismatch: "That action did not match the current screen image.",
};
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
export class HumanRouter {
  private busy = new Set<string>();
  private running = new Map<string, AbortController>();
  private history = new Map<
    string,
    {
      deadline: number;
      messages: { role: "user" | "assistant"; content: string }[];
    }
  >();
  constructor(
    readonly service: ClawdTime,
    readonly control: ControlCoordinator,
    readonly conversation?: ConversationAgent,
    readonly maintainViewing?: () => Promise<void>,
  ) {}
  async receive(input: ResponseInput): Promise<HumanResult> {
    const store = this.service.store;
    const request = store.get<AttentionRequest>("attention", input.requestId);
    if (!request) throw new Error("Unknown request.");
    const pairing = this.service.pairing(request.pairingId);
    if (
      input.memberId !== pairing.memberId ||
      input.lineId !== pairing.lineId ||
      input.conversationId !== pairing.conversationId
    )
      throw new Error("Feedback binding mismatch.");
    const text = z.string().trim().min(1).max(8000).parse(input.text);
    if (input.channel === "voice") {
      const call = store.get<CallSession>("call", input.callId ?? "");
      if (
        !input.qualifiedRemoteAudio ||
        !call ||
        call.requestId !== request.id ||
        call.state !== "connected" ||
        !call.remoteParticipantQualified
      )
        throw new Error("Unqualified voice.");
    }
    const receivedAt = this.control.now();
    const key = `human-command:${input.eventId}`,
      fingerprint = digest(JSON.stringify(input));
    const previous = store.state<{ fingerprint: string; result: HumanResult }>(
      key,
    );
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new Error("Event content changed.");
      return {
        ...previous.result,
        reply: previous.result.responseId
          ? "Your earlier feedback was passed to the waiting coding agent."
          : previous.result.stopped
            ? "Screen sharing and control are stopped."
            : previous.result.state === "unknown"
              ? "The earlier turn outcome is uncertain. I won't repeat it."
              : previous.result.state === "busy"
                ? "That request arrived while another turn was in progress. Please make a new request."
                : "I already handled that turn and won't repeat its inputs. Tell me what you'd like to do next.",
      };
    }
    const persist = (phase: string, result: HumanResult) => {
      // Never persist model-written speech, screenshots, typing, or conversation history.
      const {
        reply: _reply,
        clarification: _clarification,
        response,
        ...metadata
      } = result;
      store.saveState(key, {
        fingerprint,
        requestId: request.id,
        receivedAt,
        ...(phase !== "running" ? { finishedAt: this.control.now() } : {}),
        phase,
        result: {
          ...metadata,
          ...(response ? { responseId: response.id } : {}),
        },
      });
      return result;
    };
    const stop = async () => {
      store.saveState(`view-stopped:${request.id}`, true);
      this.running.get(request.id)?.abort();
      await this.control.stopPairing(pairing.id);
      this.history.delete(request.id);
      return { stopped: true as const };
    };
    // A local fail-safe, not an intent parser: literal Stop works without any model.
    if (isImmediateStop(text)) {
      await stop();
      return persist("stopped", {
        accepted: true,
        stopped: true,
        reply: "Screen sharing and control stopped.",
      });
    }
    if (this.busy.has(pairing.deviceId))
      return persist("busy", {
        accepted: false,
        state: "busy",
        reply:
          "I'm still handling the previous request. You can say stop at any time.",
      });
    if (
      request.deadline <= this.control.now() ||
      request.responseId ||
      !["ringing", "connected", "awaiting_input"].includes(request.state)
    )
      throw new Error("This attention request is no longer waiting.");
    const unknown: HumanResult = {
      accepted: false,
      state: "unknown",
      clarification:
        "An input or cleanup outcome is uncertain. I won't repeat it.",
    };
    persist("running", unknown);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    this.running.set(request.id, controller);
    this.busy.add(pairing.deviceId);
    let lease: ControlLease | undefined,
      observed: Observation | undefined,
      receipt: ActionReceipt | undefined;
    let response: HumanResponse | undefined,
      stopped = false,
      terminal = false,
      fatal: unknown;
    let actions = 0;
    let operation: Promise<unknown> | undefined;
    let tick: Promise<void> | undefined;
    const viewTimer = this.maintainViewing
      ? setInterval(() => {
          if (!tick)
            tick = this.maintainViewing!()
              .catch(() => {})
              .finally(() => {
                tick = undefined;
              });
        }, 1000)
      : undefined;
    const ensure = () => {
      if (fatal) throw fatal;
      if (controller.signal.aborted || terminal)
        throw new ControlPreflightError("stopped");
      const current = store.get<AttentionRequest>("attention", request.id);
      const session = store.get<AgentSession>("session", request.sessionId);
      const paired = this.service.pairing(pairing.id);
      if (
        paired.revokedAt ||
        !session ||
        session.pairingId !== paired.id ||
        session.state !== "yielded" ||
        !Number.isFinite(session.lastSeenAt ?? session.createdAt) ||
        this.control.now() - (session.lastSeenAt ?? session.createdAt) >
          20_000 ||
        (session.lastSeenAt ?? session.createdAt) > this.control.now() + 1000
      )
        throw new ControlPreflightError("context_expired");
      if (
        !current ||
        current.responseId ||
        current.sessionId !== request.sessionId ||
        current.deadline <= this.control.now() ||
        !["ringing", "connected", "awaiting_input"].includes(current.state)
      )
        throw new ControlPreflightError("context_expired");
      if (store.state(`view-stopped:${request.id}`)) {
        const screenStop = store.state<{ reason: string }>(
          `screen-stop:${request.id}`,
        );
        throw new ControlPreflightError(
          screenStop?.reason === "gateway_unavailable"
            ? "screen_unavailable"
            : "stopped",
        );
      }
    };
    const invalidPlan = (reason: ToolPreflightDiagnostics["reason"]) =>
      new ControlPreflightError("invalid_plan", {
        phase: "tool_preflight",
        elapsedMs: Math.max(
          0,
          Math.min(60_000, this.control.now() - receivedAt),
        ),
        reason,
      });
    const exclusive = async <T>(fn: () => Promise<T>): Promise<T> => {
      ensure();
      if (operation) {
        fatal = invalidPlan("parallel_tools");
        throw fatal;
      }
      const pending = fn();
      operation = pending;
      try {
        return await pending;
      } catch (error) {
        fatal = error;
        throw error;
      } finally {
        if (operation === pending) operation = undefined;
      }
    };
    const acquire = async () => {
      ensure();
      if (!pairing.allowControl) {
        const selected = store
          .all<ControlLease>("lease")
          .find(
            (l) =>
              l.requestId === request.id &&
              l.mode === "view" &&
              l.state === "active",
          );
        if (!selected) throw new ControlPreflightError("frame_unavailable");
        lease = this.control.checkView(selected.id, pairing.memberId);
      } else if (lease && store.state(`continuous-view:${lease.id}`) !== true)
        this.control.check(lease.id, pairing.memberId);
      else lease = await this.control.acquire(request.id, pairing.memberId);
      ensure();
      return lease;
    };
    const capture = async (): Promise<Observation> => {
      const current = await acquire();
      const image = await this.conversation!.observe(current).catch(() => {
        throw new ControlPreflightError("frame_unavailable");
      });
      ensure();
      if (current.mode === "view")
        this.control.checkView(current.id, pairing.memberId);
      else this.control.check(current.id, pairing.memberId);
      const frame = z
        .object({
          id: z.string().min(1).max(160),
          capturedAt: z.number().finite(),
          width: z.number().int().min(1).max(1280),
          height: z.number().int().min(1).max(720),
        })
        .parse(image.frame);
      if (
        this.control.now() - frame.capturedAt > 2000 ||
        frame.capturedAt > this.control.now() + 250 ||
        !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image.dataUrl) ||
        image.dataUrl.length > 2_000_000
      )
        throw new ControlPreflightError("frame_unavailable");
      store.saveState(`frame:${current.id}`, frame);
      return { frame, dataUrl: image.dataUrl };
    };
    const releaseAll = async () => {
      await this.control.stopPairing(pairing.id);
      const leases = store
        .all<ControlLease>("lease")
        .filter((l) => l.requestId === request.id);
      if (
        leases.some((l) => l.state !== "released") ||
        store
          .all<ActionReceipt>("action")
          .some(
            (a) =>
              leases.some((l) => l.id === a.leaseId) &&
              ["pending", "submitted", "unknown"].includes(a.state),
          )
      )
        throw new Error("Control release remains uncertain.");
    };
    const recordScreenFeedback = (visible: boolean) => {
      ensure();
      const current = store.get<AttentionRequest>("attention", request.id)!;
      const call = store.get<CallSession>("call", current.callId ?? "");
      if (
        !call ||
        call.state !== "connected" ||
        !call.remoteParticipantQualified ||
        call.requestId !== request.id ||
        call.pairingId !== pairing.id
      )
        throw new ControlPreflightError("context_expired");
      store.saveState(`screen-feedback:${request.id}`, {
        eventId: input.eventId,
        requestId: request.id,
        sessionId: request.sessionId,
        pairingId: pairing.id,
        callId: call.id,
        visible,
        reportedAt: receivedAt,
      });
      return { recorded: true as const };
    };
    const tools: ConversationTools = {
      observe: () => exclusive(async () => (observed = await capture())),
      act: (frameId, rawAction) =>
        exclusive(async () => {
          if (!pairing.allowControl)
            throw new ControlPreflightError("planning_refused");
          const parsedAction = actionSchema.safeParse(rawAction);
          if (!parsedAction.success) throw invalidPlan("action_invalid");
          const action = parsedAction.data;
          if (!observed) throw invalidPlan("observation_missing");
          if (observed.frame.id !== frameId)
            throw invalidPlan("frame_mismatch");
          const before = observed,
            fresh = await capture();
          observed = fresh;
          if (
            before.frame.width !== fresh.frame.width ||
            before.frame.height !== fresh.frame.height
          )
            throw new ControlPreflightError("screen_changed");
          const actionId = `input_${digest(`${input.eventId}:${++actions}`).slice(0, 40)}`;
          store.saveState(key, {
            fingerprint,
            requestId: request.id,
            receivedAt,
            phase: "input",
            actionId,
            result: unknown,
          });
          // Refresh the native frame stamp for dispatch; the model chose this
          // action from its preceding observation. Ordinary pixel changes do not
          // veto that decision. The returned image lets it inspect the result.
          receipt = await this.control.act(
            lease!.id,
            pairing.memberId,
            actionId,
            fresh.frame.id,
            action,
          );
          if (receipt.state !== "observed")
            throw new Error("Input outcome is uncertain.");
          observed = await capture();
          return { ...observed, receipt };
        }),
      feedback: (options) =>
        exclusive(async () => {
          const parsed = z
            .object({
              kind: z.enum(["answer", "correction"]).optional(),
              screenVisible: z.boolean().optional(),
            })
            .strict()
            .parse(options);
          await releaseAll();
          ensure();
          if (parsed.screenVisible !== undefined)
            recordScreenFeedback(parsed.screenVisible);
          response = this.service.receiveResponse({
            ...input,
            text,
            kind: parsed.kind ?? "answer",
          });
          store.saveState(`view-stopped:${request.id}`, true);
          terminal = true;
          this.history.delete(request.id);
          return { responseId: response.id };
        }),
      screenFeedback: (options) =>
        exclusive(async () =>
          recordScreenFeedback(
            z.object({ visible: z.boolean() }).strict().parse(options).visible,
          ),
        ),
      stop: () =>
        exclusive(async () => {
          await stop();
          stopped = true;
          terminal = true;
          return { stopped: true };
        }),
    };
    let reply: string | undefined, failure: unknown;
    try {
      ensure();
      if (this.maintainViewing) await this.maintainViewing();
      ensure();
      if (!this.conversation)
        throw new ControlPreflightError("planner_unavailable");
      for (const [id, old] of this.history)
        if (old.deadline <= this.control.now()) this.history.delete(id);
      const result = await this.conversation.run({
        text,
        question: request.question,
        history: this.history.get(request.id)?.messages ?? [],
        signal: controller.signal,
        capabilities: { control: pairing.allowControl },
        tools,
      });
      reply = z.string().trim().min(1).max(900).parse(result.reply);
      if (fatal) throw fatal;
      if (!terminal) ensure();
    } catch (error) {
      failure = fatal ?? error;
    } finally {
      controller.abort();
      clearTimeout(timeout);
      if (viewTimer) clearInterval(viewTimer);
      // An SDK timeout must not race cleanup against an already-dispatched helper operation.
      if (operation) await operation.catch(() => {});
      failure = fatal ?? failure;
      if (tick) await tick;
      try {
        const owned = store
          .all<ControlLease>("lease")
          .filter((l) => l.requestId === request.id);
        const unresolved = store
          .all<ActionReceipt>("action")
          .some(
            (a) =>
              owned.some((l) => l.id === a.leaseId) &&
              ["pending", "submitted", "unknown"].includes(a.state),
          );
        const unknownLease = owned.some((l) => l.state === "unknown");
        if (
          unresolved ||
          unknownLease ||
          (failure && !(failure instanceof ControlPreflightError))
        ) {
          await releaseAll();
        } else if (lease && store.state(`continuous-view:${lease.id}`) !== true)
          await this.control.release(lease.id);
        if (
          unresolved ||
          store
            .all<ControlLease>("lease")
            .some((l) => l.requestId === request.id && l.state === "unknown")
        )
          throw new Error("Unknown input or lease.");
      } catch {
        failure = new Error("Control cleanup uncertain.");
      }
      this.busy.delete(pairing.deviceId);
      if (this.running.get(request.id) === controller)
        this.running.delete(request.id);
    }
    if (response || stopped)
      return persist("completed", {
        accepted: true,
        response,
        stopped,
        reply:
          reply ??
          (stopped
            ? "Screen sharing stopped."
            : "I've passed your response to the waiting coding agent."),
      });
    if (failure) {
      if (failure instanceof ControlPreflightError) {
        const diagnostics = sanitizeControlPreflightDiagnostics(
          failure.diagnostics,
        );
        store.saveState(`control-preflight:${request.id}`, {
          code: failure.code,
          at: this.control.now(),
          ...(diagnostics ? { diagnostics } : {}),
        });
        return persist("not_started", {
          accepted: false,
          state: receipt ? "partial" : "not_started",
          code: failure.code,
          ...(diagnostics ? { diagnostics } : {}),
          receipt,
          reply: receipt
            ? "I paused after the last observed input. I couldn't safely finish the remaining steps."
            : failure.code === "invalid_plan" &&
                diagnostics?.phase === "tool_preflight"
              ? `${toolFailureReplies[diagnostics.reason]} No computer input was sent.`
              : failure.code === "planner_unavailable"
                ? "I couldn't process that request because the conversation service failed. No computer input was sent."
                : failure.code === "planning_timeout"
                  ? "I couldn't process that request in time. No computer input was sent."
                  : failure.code === "frame_unavailable"
                    ? "I don't have a fresh screen image to work from. No computer input was sent."
                    : `${new ControlPreflightError(failure.code).message} No computer input was sent.`,
        });
      }
      return persist("unknown", {
        ...unknown,
        receipt,
        reply: unknown.clarification,
      });
    }
    const history = [
      ...(this.history.get(request.id)?.messages ?? []),
      { role: "user" as const, content: text },
      { role: "assistant" as const, content: reply! },
    ].slice(-8);
    this.history.set(request.id, {
      deadline: request.deadline,
      messages: history,
    });
    return persist("completed", { accepted: true, reply, receipt });
  }
}
