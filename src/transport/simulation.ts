import type { AttentionRequest, Pairing, Transport } from "../contracts.js";
import { hash } from "../storage/security.js";
/** Explicit simulation: these receipts are never represented as provider delivery. */
export class SimulationTransport implements Transport {
  readonly mode = "simulation" as const;
  readonly calls: { requestId: string; effectId: string; callId: string }[] =
    [];
  readonly messages: { pairingId: string; text: string; effectId: string }[] =
    [];
  readonly ended: string[] = [];
  readonly spoken: { requestId: string; replyId: string; text: string }[] = [];
  async speechStatus(
    _request: AttentionRequest,
    _pairing: Pairing,
    replyId: string,
  ) {
    return {
      state: this.spoken.some((s) => s.replyId === replyId)
        ? ("completed" as const)
        : ("unknown" as const),
    };
  }
  async speak(
    request: AttentionRequest,
    _pairing: Pairing,
    replyId: string,
    text: string,
    reconcileOnly = false,
  ) {
    const prior = this.spoken.find((s) => s.replyId === replyId);
    if (!prior && !reconcileOnly)
      this.spoken.push({ requestId: request.id, replyId, text });
    return {
      state:
        prior || !reconcileOnly ? ("completed" as const) : ("unknown" as const),
    };
  }
  async call(request: AttentionRequest, _pairing: Pairing, effectId: string) {
    const callId = `sim_${hash(effectId).slice(0, 32)}`;
    if (!this.calls.some((c) => c.effectId === effectId))
      this.calls.push({ requestId: request.id, effectId, callId });
    return { callId, accepted: true };
  }
  async message(pairing: Pairing, text: string, effectId: string) {
    if (!this.messages.some((m) => m.effectId === effectId))
      this.messages.push({ pairingId: pairing.id, text, effectId });
    return { simulated: true, accepted: true, receiptId: effectId };
  }
  async endCall(callId: string, effectId: string) {
    if (!this.ended.includes(callId)) this.ended.push(callId);
    return { simulated: true, accepted: true, actionId: effectId };
  }
}
