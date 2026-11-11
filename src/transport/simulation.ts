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
