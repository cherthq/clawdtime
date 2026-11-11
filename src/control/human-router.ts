import { createHash } from "node:crypto";
import { z } from "zod";
import type { ClawdTime, ResponseInput } from "../attention/service.js";
import type { ControlLease, Frame, InputAction } from "../contracts.js";
import { actionSchema, ControlCoordinator } from "./coordinator.js";

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
    if (action) action = actionSchema.parse(action);
    if (task && !this.planner)
      throw new Error(
        "A single-action vision provider is not configured. Direct click/type/scroll remain available.",
      );
    // Record intent before any async work, so replay cannot acquire a fresh action ID.
    this.control.context(request.id, pairing.memberId);
    if (this.busy.has(pairing.deviceId))
      throw new Error("Another human action is still in progress.");
    this.busy.add(pairing.deviceId);
    this.service.store.saveState(key, {
      fingerprint,
      result: {
        accepted: false,
        state: "unknown",
        reason: "Inspect the retained action receipt; do not repeat input.",
      },
    });
    let lease: ControlLease | undefined,
      observed = false;
    try {
      const active = this.service.store
        .all<ControlLease>("lease")
        .filter((l) => l.requestId === request.id && l.state === "active");
      if (active.some((l) => l.mode === "control"))
        throw new Error("Control remains reserved.");
      for (const old of active) await this.control.release(old.id);
      lease = await this.control.acquire(request.id, pairing.memberId);
      let frame: Frame;
      if (task) {
        const planned = await this.planner!.plan(task, lease);
        action = actionSchema.parse(planned.action);
        frame = planned.frame;
        this.control.check(lease.id, pairing.memberId);
        this.service.store.saveState(`frame:${lease.id}`, frame);
      } else frame = await this.control.frame(lease.id, pairing.memberId);
      const actionId = `input_${createHash("sha256").update(input.eventId).digest("hex").slice(0, 40)}`;
      const receipt = await this.control.act(
        lease.id,
        pairing.memberId,
        actionId,
        frame.id,
        action!,
      );
      observed = true;
      const result = {
        accepted: true,
        receipt,
        note: "Input submitted and a subsequent frame observed; this does not prove the application completed the intended task.",
      };
      this.service.store.saveState(key, { fingerprint, result });
      return result;
    } finally {
      try {
        if (lease) await this.control.release(lease.id);
        if (observed && !this.service.store.state(`view-stopped:${request.id}`))
          this.service.store.saveState(`view-restore:${request.id}`, true);
      } finally {
        this.busy.delete(pairing.deviceId);
      }
    }
  }
}
