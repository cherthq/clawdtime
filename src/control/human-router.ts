import { createHash } from "node:crypto";
import { z } from "zod";
import type { ClawdTime, ResponseInput } from "../attention/service.js";
import type {
  ActionReceipt,
  ControlLease,
  Frame,
  InputAction,
} from "../contracts.js";
import { actionSchema, ControlCoordinator } from "./coordinator.js";
import {
  ControlPreflightError,
  sanitizeControlPreflightDiagnostics,
} from "./errors.js";

export interface SingleActionPlanner {
  plan(
    task: string,
    lease: ControlLease,
  ): Promise<{ action: InputAction; frame: Frame }>;
}
export class HumanRouter {
  private busy = new Set<string>();
  constructor(
    readonly service: ClawdTime,
    readonly control: ControlCoordinator,
    readonly planner?: SingleActionPlanner,
  ) {}
  async receive(input: ResponseInput) {
    // Authenticate all bindings before interpreting a command. No model resolves identity.
    const request = this.service.store.get<
      import("../contracts.js").AttentionRequest
    >("attention", input.requestId);
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
      const call = this.service.store.get<
        import("../contracts.js").CallSession
      >("call", input.callId ?? "");
      if (
        !input.qualifiedRemoteAudio ||
        !call ||
        call.requestId !== request.id ||
        call.state !== "connected" ||
        !call.remoteParticipantQualified
      )
        throw new Error("Unqualified voice.");
    }
    const key = `human-command:${input.eventId}`,
      fingerprint = createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex");
    const prior = this.service.store.state<{
      fingerprint: string;
      result: unknown;
    }>(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new Error("Event content changed.");
      return prior.result;
    }
    if (/^stop(?: control| sharing)?$/i.test(text)) {
      this.service.store.saveState(`view-stopped:${request.id}`, true);
      await this.control.stopPairing(pairing.id);
      const result = { accepted: true, stopped: true };
      this.service.store.saveState(key, { fingerprint, result });
      return result;
    }
    let action: InputAction | undefined, task: string | undefined;
    if (/^type: /i.test(text)) action = { kind: "type", text: text.slice(6) };
    else if (/^click /i.test(text)) {
      const m =
        /^click (0(?:\.\d+)?|1(?:\.0+)?) (0(?:\.\d+)?|1(?:\.0+)?)$/i.exec(text);
      if (!m)
        throw new Error(
          "Use click X Y, with normalized coordinates from 0 to 1.",
        );
      action = { kind: "click", x: Number(m[1]), y: Number(m[2]) };
    } else if (/^scroll /i.test(text)) {
      const m = /^scroll (-?\d+) at ([\d.]+) ([\d.]+)$/i.exec(text);
      if (!m) throw new Error("Use scroll DELTA at X Y.");
      action = {
        kind: "scroll",
        deltaY: Number(m[1]),
        x: Number(m[2]),
        y: Number(m[3]),
      };
    } else if (/^do: /i.test(text)) task = text.slice(4);
    if (!action && !task) {
      if (!/^answer: |^correction: /i.test(text))
        return {
          accepted: false,
          clarification:
            "Use answer: your reply, type: text, click X Y, scroll DELTA at X Y, do: one action, or stop.",
        };
      this.service.store.saveState(`view-stopped:${request.id}`, true);
      await this.control.stopPairing(pairing.id);
      const response = this.service.receiveResponse({
        ...input,
        text: text.replace(/^(answer|correction): /i, ""),
        kind: /^correction:/i.test(text) ? "correction" : "answer",
      });
      const result = { accepted: true, response };
      this.service.store.saveState(key, { fingerprint, result });
      return result;
    }
    if (this.busy.has(pairing.deviceId))
      throw new Error("Another human action is still in progress.");
    const actionId = `input_${createHash("sha256").update(input.eventId).digest("hex").slice(0, 40)}`;
    const focusKey = `focus-unverified:${createHash("sha256")
      .update(JSON.stringify([pairing.deviceId, pairing.displayId]))
      .digest("hex")}`;
    const explicitClick = !task && action?.kind === "click";
    const originalLeases = this.service.store.all<ControlLease>("lease");
    const priorView = originalLeases.some(
      (l) =>
        l.requestId === request.id && l.mode === "view" && l.state === "active",
    );
    const releasing = new Set<string>();
    const remember = (phase: string, result: unknown) =>
      this.service.store.saveState(key, {
        fingerprint,
        actionId,
        phase,
        result,
      });
    const unknown = {
      accepted: false,
      state: "unknown",
      actionId,
      clarification:
        "The input or control cleanup outcome is uncertain. Inspect the retained receipt; do not repeat the command.",
    };
    // A stable command ID is retained before asynchronous planning or helper work.
    remember("preflight", unknown);
    this.busy.add(pairing.deviceId);
    let lease: ControlLease | undefined,
      receipt: ActionReceipt | undefined,
      failure: unknown,
      cleanupFailed = false,
      focusBlocked = false;
    let originalContext: ReturnType<ControlCoordinator["context"]> | undefined;
    try {
      originalContext = this.control.context(request.id, pairing.memberId);
      if (action) {
        const parsed = actionSchema.safeParse(action);
        if (!parsed.success) throw new ControlPreflightError("invalid_plan");
        action = parsed.data;
      }
      if (action?.kind === "type" && this.service.store.state(focusKey)) {
        focusBlocked = true;
        throw new ControlPreflightError("invalid_plan");
      }
      if (task && !this.planner)
        throw new ControlPreflightError("planner_unavailable");
      const active = this.service.store
        .all<ControlLease>("lease")
        .filter((l) => l.requestId === request.id && l.state === "active");
      if (active.some((l) => l.mode === "control"))
        throw new Error("Control remains reserved.");
      for (const old of active) {
        releasing.add(old.id);
        await this.control.release(old.id);
        this.control.context(request.id, pairing.memberId);
      }
      lease = await this.control.acquire(request.id, pairing.memberId);
      let frame: Frame;
      if (task) {
        remember("planning", unknown);
        const planned = await this.planner!.plan(task, lease);
        const parsed = actionSchema.safeParse(planned.action);
        if (!parsed.success) throw new ControlPreflightError("invalid_plan");
        action = parsed.data;
        if (action.kind === "type" && this.service.store.state(focusKey)) {
          focusBlocked = true;
          throw new ControlPreflightError("invalid_plan");
        }
        frame = {
          id: planned.frame.id,
          capturedAt: planned.frame.capturedAt,
          width: planned.frame.width,
          height: planned.frame.height,
        };
        this.control.check(lease.id, pairing.memberId);
        this.service.store.saveState(`frame:${lease.id}`, frame);
      } else frame = await this.control.frame(lease.id, pairing.memberId);
      remember("input", unknown);
      receipt = await this.control.act(
        lease.id,
        pairing.memberId,
        actionId,
        frame.id,
        action!,
      );
    } catch (error) {
      failure = error;
      if (task) this.service.store.saveState(focusKey, true);
    } finally {
      try {
        if (lease) {
          releasing.add(lease.id);
          try {
            await this.control.release(lease.id);
          } catch {
            cleanupFailed = true;
          }
        }
        const allLeases = this.service.store.all<ControlLease>("lease");
        // acquire() persists its reservation before awaiting the helper, including
        // cases where it throws before returning the lease to this router.
        const newlyReserved = allLeases.filter(
          (l) =>
            l.requestId === request.id &&
            l.mode === "control" &&
            !originalLeases.some((old) => old.id === l.id),
        );
        for (const reserved of newlyReserved) releasing.add(reserved.id);
        const releasesKnown =
          !cleanupFailed &&
          [...releasing].every(
            (id) =>
              this.service.store.get<ControlLease>("lease", id)?.state ===
              "released",
          );
        const storedReceipt = this.service.store.get<ActionReceipt>(
          "action",
          actionId,
        );
        const notStarted =
          failure instanceof ControlPreflightError &&
          !storedReceipt &&
          releasesKnown;
        const observed = receipt?.state === "observed" && releasesKnown;
        if (explicitClick && observed)
          this.service.store.saveState(focusKey, false);
        // Restoration only resumes the previously selected screen. It never
        // clears Stop, grants new consent or bypasses an uncertain input/release.
        if (
          priorView &&
          releasing.size &&
          (observed || notStarted) &&
          releasesKnown
        ) {
          try {
            const current = this.control.context(request.id, pairing.memberId);
            const expectedEpoch =
              lease?.epoch ??
              (newlyReserved.length === 1
                ? newlyReserved[0]!.epoch
                : originalContext?.session.controlEpoch);
            const displayLeases = allLeases.filter(
              (l) =>
                l.deviceId === pairing.deviceId &&
                l.displayId === pairing.displayId,
            );
            const uncertainInput = this.service.store
              .all<ActionReceipt>("action")
              .some(
                (a) =>
                  displayLeases.some((l) => l.id === a.leaseId) &&
                  ["pending", "submitted", "unknown"].includes(a.state),
              );
            if (
              originalContext &&
              current.session.id === originalContext.session.id &&
              current.call.id === originalContext.call.id &&
              current.session.controlEpoch === expectedEpoch &&
              !current.request.responseId &&
              displayLeases.every((l) => l.state === "released") &&
              !uncertainInput &&
              !this.service.store.state(`view-stopped:${request.id}`)
            )
              this.service.store.saveState(`view-restore:${request.id}`, true);
          } catch {
            /* Closed calls, stale epochs and Stop never rearm viewing. */
          }
        }
        if (notStarted) {
          const focusWarning = !!this.service.store.state(focusKey);
          // Sanitize again at persistence: error objects can be changed after construction.
          const diagnostics = sanitizeControlPreflightDiagnostics(
            (failure as ControlPreflightError).diagnostics,
          );
          const result = {
            accepted: false,
            state: "not_started",
            actionId,
            code: (failure as ControlPreflightError).code,
            ...(diagnostics ? { diagnostics } : {}),
            clarification: focusBlocked
              ? "No input was sent. The earlier screen action did not establish focus. Send an explicit click command, visually verify the intended textbox, then send typing as a separate command."
              : `No input was sent. ${(failure as ControlPreflightError).message}${focusWarning ? " Before typing, send an explicit click command and visually verify the intended textbox." : " Review the screen before issuing a new command."}`,
          };
          remember("not_started", result);
          return result;
        }
        if (observed) {
          const result = {
            accepted: true,
            receipt,
            note: "Input submitted and a subsequent frame observed; this does not prove the application completed the intended task. Visually verify focus before typing.",
          };
          remember("observed", result);
          return result;
        }
        remember("unknown", {
          ...unknown,
          ...(storedReceipt ? { receipt: storedReceipt } : {}),
          cleanup: releasesKnown ? "confirmed" : "unknown",
        });
      } finally {
        this.busy.delete(pairing.deviceId);
      }
    }
    throw new Error(
      "Input or control cleanup outcome is uncertain; inspect the retained receipt and do not repeat input.",
    );
  }
}
