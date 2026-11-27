import { createHmac, randomInt } from "node:crypto";
import { z } from "zod";
import type { Pairing } from "../contracts.js";
import {
  accountIdentitySchema,
  verifiedAliasSchema,
  routingProviderEventSchema,
  callProofTurnSchema,
  routingId,
  type SharedNumberVerifiers,
  type SharedMember,
  type SharedDeviceCredential,
  type SharedConnection,
  type SharedCall,
  type SharedCallProof,
  type SharedTaskOwnership,
  type SharedCallbackOwnership,
} from "../shared-number-contracts.js";
import { Store } from "../storage/store.js";
import { DomainError, equal, hash, id, token } from "../storage/security.js";

interface Invitation {
  id: string;
  memberId: string;
  expiresAt: number;
  consumedAt?: number;
}
const kind = (name: string) => `shared_number_${name}`;
/** A caller who has not verified within this time is released, so one
 * unverified call cannot hold the single line slot. */
export const UNVERIFIED_LIMIT_MS = 90_000;
const refused = () => new DomainError(403, "shared_number_unauthorized");
const conflict = () => new DomainError(409, "shared_number_conflict");
const notWaiting = () => new DomainError(409, "shared_call_not_waiting");
// Verifiers may refresh the lifetime of their attestation on redelivery.
// Check that lifetime separately, but fingerprint only the stable event/turn.
const stableEvidence = <T extends { expiresAt: number }>(evidence: T) => {
  const { expiresAt: _expiresAt, ...payload } = evidence;
  return JSON.stringify(payload);
};
const acceptanceSchema = z
  .object({
    localAccepted: z.literal(true),
    displayId: routingId,
    allowView: z.boolean(),
    allowControl: z.boolean(),
  })
  .strict()
  .refine((v) => !v.allowControl || v.allowView);

/** Staged domain only: no listener, provider dispatch, screen capture or input.
 * One coordinator and one durable database must own the line. Inject real
 * identity/event verifiers before exposing any of these methods to a network.
 * Device credentials are never account credentials. No legacy/default route. */
export class SharedNumber {
  private readonly connections = new Map<string, SharedConnection>();
  private readonly now: () => number;
  private readonly lineId: string;
  constructor(
    private readonly store: Store,
    private readonly options: {
      lineId: string;
      proofKey: string;
      verifiers: SharedNumberVerifiers;
      now?: () => number;
    },
  ) {
    this.lineId = routingId.parse(options.lineId);
    if (!/^[a-f0-9]{64}$/i.test(options.proofKey))
      throw new Error("Shared routing needs a separate 32-byte proof key.");
    this.now = options.now ?? Date.now;
    // A restart cannot resume a desktop admission from an old connection.
    // Keep the slot reserved until exact provider cleanup is reconciled.
    this.store.transaction(() => {
      for (const call of this.store.all<SharedCall>(kind("call"))) {
        if (call.lineId === this.lineId && call.state === "admitted")
          this.store.put(kind("call"), { ...call, state: "outcome_unknown" });
      }
    });
  }

  private async account(proof: unknown) {
    const account = accountIdentitySchema.parse(
      await this.options.verifiers.account(proof),
    );
    if (account.expiresAt <= this.now()) throw refused();
    return account;
  }
  private member(memberId: string) {
    const member = this.store.get<SharedMember>(kind("member"), memberId);
    if (
      !member ||
      member.revokedAt !== undefined ||
      member.alias.lineId !== this.lineId
    )
      throw refused();
    return member;
  }
  private pairing(memberId: string) {
    const member = this.member(memberId);
    const pair = member.pairingId
      ? this.store.get<Pairing>(kind("pairing"), member.pairingId)
      : undefined;
    if (
      !pair ||
      pair.revokedAt !== undefined ||
      pair.memberId !== memberId ||
      pair.lineId !== this.lineId
    )
      throw refused();
    return pair;
  }

  async enroll(accountProof: unknown, aliasProof: unknown) {
    const account = await this.account(accountProof);
    const alias = verifiedAliasSchema.parse(
      await this.options.verifiers.alias(aliasProof),
    );
    if (
      account.expiresAt <= this.now() ||
      alias.expiresAt <= this.now() ||
      alias.memberId !== account.memberId ||
      alias.lineId !== this.lineId
    )
      throw refused();
    return this.store.transaction(() => {
      const old = this.store.get<SharedMember>(
        kind("member"),
        account.memberId,
      );
      if (old) {
        if (
          old.revokedAt !== undefined ||
          old.alias.recipient !== alias.recipient ||
          old.alias.conversationId !== alias.conversationId ||
          old.alias.lineId !== alias.lineId
        )
          throw conflict();
        return old;
      }
      // An alias never silently moves between accounts, including revoked ones.
      if (
        this.store
          .all<SharedMember>(kind("member"))
          .some(
            (m) =>
              m.alias.lineId === alias.lineId &&
              (m.alias.recipient === alias.recipient ||
                m.alias.conversationId === alias.conversationId),
          )
      )
        throw conflict();
      return this.store.put<SharedMember>(kind("member"), {
        id: account.memberId,
        alias,
      });
    });
  }

  async invite(accountProof: unknown) {
    const account = await this.account(accountProof);
    return this.store.transaction(() => {
      const member = this.member(account.memberId);
      // First release has one selected Mac, with no implicit replacement.
      if (member.pairingId) throw conflict();
      const secret = token();
      const invitation = this.store.put<Invitation>(kind("invite"), {
        id: hash(secret),
        memberId: member.id,
        expiresAt: this.now() + 300_000,
      });
      return { invitation: secret, expiresAt: invitation.expiresAt };
    });
  }

  /** Called by the local pairing UI only after explicit acceptance. The
   * invitation was delivered through the authenticated account, never caller ID. */
  acceptInvitation(secret: string, rawAcceptance: unknown) {
    const acceptance = acceptanceSchema.parse(rawAcceptance);
    return this.store.transaction(() => {
      const invite = this.store.get<Invitation>(kind("invite"), hash(secret));
      if (
        !invite ||
        invite.consumedAt !== undefined ||
        invite.expiresAt <= this.now()
      )
        throw refused();
      const member = this.member(invite.memberId);
      if (member.pairingId) throw conflict();
      const pair: Pairing = {
        id: id("pair"),
        memberId: member.id,
        lineId: this.lineId,
        recipient: member.alias.recipient,
        conversationId: member.alias.conversationId,
        deviceId: id("mac"),
        displayId: acceptance.displayId,
        allowView: acceptance.allowView,
        allowControl: acceptance.allowControl,
        createdAt: this.now(),
      };
      this.store.put(kind("pairing"), pair);
      this.store.put(kind("member"), { ...member, pairingId: pair.id });
      this.store.put(kind("invite"), { ...invite, consumedAt: this.now() });
      return { pairing: pair, credential: this.issueCredential(pair) };
    });
  }
  private issueCredential(pair: Pairing) {
    const secret = token();
    const credential = this.store.put<SharedDeviceCredential>(
      kind("credential"),
      {
        id: id("credential"),
        pairingId: pair.id,
        memberId: pair.memberId,
        deviceId: pair.deviceId,
        digest: hash(secret),
        createdAt: this.now(),
      },
    );
    return `${credential.id}.${secret}`;
  }
  private authenticate(credential: string) {
    const parts = credential.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw refused();
    const record = this.store.get<SharedDeviceCredential>(
      kind("credential"),
      parts[0],
    );
    if (
      !record ||
      record.revokedAt !== undefined ||
      !equal(record.digest, hash(parts[1]))
    )
      throw refused();
    const pair = this.pairing(record.memberId);
    if (record.pairingId !== pair.id || record.deviceId !== pair.deviceId)
      throw refused();
    return { record, pair };
  }
  /** A cheap credential check that runs before a device request body is read. */
  authenticateDevice(credential: string) {
    if (credential.length > 512) throw refused();
    this.authenticate(credential);
  }
  rotateCredential(credential: string) {
    return this.store.transaction(() => {
      const { record, pair } = this.authenticate(credential);
      this.store.put(kind("credential"), { ...record, revokedAt: this.now() });
      this.fenceDevice(pair.deviceId);
      // Lost delivery does not resurrect the old secret or replay issuance.
      return this.issueCredential(pair);
    });
  }
  async revoke(accountProof: unknown) {
    const account = await this.account(accountProof);
    this.store.transaction(() => {
      const member = this.member(account.memberId);
      this.store.put(kind("member"), { ...member, revokedAt: this.now() });
      if (!member.pairingId) return;
      const pair = this.store.get<Pairing>(kind("pairing"), member.pairingId)!;
      this.store.put(kind("pairing"), { ...pair, revokedAt: this.now() });
      for (const c of this.store.all<SharedDeviceCredential>(
        kind("credential"),
      ))
        if (c.pairingId === pair.id && c.revokedAt === undefined)
          this.store.put(kind("credential"), { ...c, revokedAt: this.now() });
      this.fenceDevice(pair.deviceId);
    });
  }

  /** Device IDs are derived from the credential, never from a header. A fresh
   * connection fences the previous socket even if its instance ID is reused. */
  connect(credential: string, desktopInstanceId: string) {
    routingId.parse(desktopInstanceId);
    return this.store.transaction(() => {
      const { record, pair } = this.authenticate(credential);
      this.fenceDevice(pair.deviceId);
      const connection: SharedConnection = {
        id: id("connection"),
        credentialId: record.id,
        memberId: pair.memberId,
        pairingId: pair.id,
        deviceId: pair.deviceId,
        desktopInstanceId,
        expiresAt: this.now() + 30_000,
      };
      this.connections.set(pair.deviceId, connection);
      return { ...connection };
    });
  }
  heartbeat(credential: string, connectionId: string) {
    const connection = this.connection(credential, connectionId);
    connection.expiresAt = this.now() + 30_000;
    return { ...connection };
  }
  /** Authenticated transport lookup. Never accept a client-selected device ID. */
  deviceConnection(credential: string, connectionId: string) {
    return { ...this.connection(credential, connectionId) };
  }
  disconnect(credential: string, connectionId: string) {
    const connection = this.connection(credential, connectionId);
    this.store.transaction(() => this.fenceDevice(connection.deviceId));
  }
  private connection(credential: string, connectionId: string) {
    const { pair, record } = this.authenticate(credential);
    const connection = this.connections.get(pair.deviceId);
    if (
      !connection ||
      connection.id !== connectionId ||
      connection.credentialId !== record.id ||
      connection.expiresAt <= this.now()
    )
      throw refused();
    return connection;
  }
  private fenceDevice(deviceId: string) {
    this.connections.delete(deviceId);
    for (const call of this.store.all<SharedCall>(kind("call")))
      if (call.scope?.deviceId === deviceId && call.state === "admitted")
        this.store.put(kind("call"), { ...call, state: "outcome_unknown" });
  }

  /** A verified incoming event reserves the line only. It grants no Mac access.
   * Signed event replays return the original record; changed bindings conflict. */
  async providerEvent(evidence: unknown) {
    const event = routingProviderEventSchema.parse(
      await this.options.verifiers.provider(evidence),
    );
    if (event.lineId !== this.lineId || event.expiresAt <= this.now())
      throw refused();
    return this.store.transaction(() => {
      const eventKey = `shared-provider:${hash(JSON.stringify([this.lineId, event.eventId]))}`;
      const fingerprint = hash(stableEvidence(event));
      const prior = this.store.event<{ callId: string }>(eventKey);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw conflict();
        return this.call(prior.result.callId);
      }
      const callId = `shared_call_${hash(JSON.stringify([this.lineId, event.providerCallId]))}`;
      const old = this.store.get<SharedCall>(kind("call"), callId);
      if (
        old &&
        (old.roomId !== event.roomId ||
          old.participantId !== event.participantId)
      )
        throw conflict();
      let call: SharedCall;
      if (event.kind === "incoming") {
        call = old ?? {
          id: callId,
          lineId: this.lineId,
          providerCallId: event.providerCallId,
          roomId: event.roomId,
          participantId: event.participantId,
          state: this.slot() ? "busy" : "unknown_identity",
          createdAt: this.now(),
          ...(event.caller
            ? { callerDigest: this.callerDigest(event.caller) }
            : {}),
        };
        if (!old && call.state !== "busy")
          this.store.saveState(this.slotKey(), call.id);
      } else {
        // Cleanup can arrive before incoming. Retain its terminal binding so a
        // delayed incoming event cannot reserve the slot for an ended call.
        call = {
          ...(old ?? {
            id: callId,
            lineId: this.lineId,
            providerCallId: event.providerCallId,
            roomId: event.roomId,
            participantId: event.participantId,
            createdAt: this.now(),
          }),
          state: "ended",
          cleanupAt: old?.cleanupAt ?? this.now(),
        };
        if (this.slot() === call.id) this.store.saveState(this.slotKey(), null);
      }
      this.store.put(kind("call"), call);
      this.store.recordEvent(eventKey, fingerprint, { callId: call.id });
      return call;
    });
  }
  private slotKey() {
    return `shared-number-slot:${this.lineId}`;
  }
  private slot() {
    return this.store.state<string | null>(this.slotKey());
  }
  private call(callId: string) {
    const call = this.store.get<SharedCall>(kind("call"), callId);
    if (!call || call.lineId !== this.lineId) throw refused();
    return call;
  }
  private callerDigest(handle: string) {
    return createHmac("sha256", Buffer.from(this.options.proofKey, "hex"))
      .update(JSON.stringify(["caller", this.lineId, handle]))
      .digest("hex");
  }
  /** Only the member whose verified number placed the call may be shown its
   * code. A callback is bound to its original member instead. Selection only:
   * the code from the paired Mac still has to be spoken on this call. */
  private callerIs(call: SharedCall, memberId: string) {
    if (call.expectedMemberId) return call.expectedMemberId === memberId;
    if (!call.callerDigest) return false;
    const member = this.member(memberId);
    return equal(call.callerDigest, this.callerDigest(member.alias.recipient));
  }
  private proofDigest(callId: string, code: string) {
    return createHmac("sha256", Buffer.from(this.options.proofKey, "hex"))
      .update(JSON.stringify([this.lineId, callId, code]))
      .digest("hex");
  }

  /** The paired Mac itself asks for the code, with its own device credential
   * and over its live connection, and shows it to the person at that Mac. A
   * sign-in session alone never receives a call code. The voice model must
   * never generate it, select a member, or receive any credential. */
  issueCallProof(credential: string, callId?: string) {
    if (callId !== undefined) routingId.parse(callId);
    return this.store.transaction(() => {
      const { record, pair } = this.authenticate(credential);
      const connection = this.connections.get(pair.deviceId);
      if (
        !connection ||
        connection.credentialId !== record.id ||
        connection.expiresAt <= this.now()
      )
        throw notWaiting();
      const call = this.waitingCall();
      // The same answer for no call and another member's call: one member
      // can neither take, block nor detect another member's waiting call.
      if (
        !call ||
        (callId !== undefined && callId !== call.id) ||
        !this.callerIs(call, pair.memberId)
      )
        throw notWaiting();
      if (this.store.get(kind("proof"), call.id)) throw conflict();
      const code = randomInt(100_000_000).toString().padStart(8, "0");
      const proof = this.store.put<SharedCallProof>(kind("proof"), {
        id: call.id,
        callId: call.id,
        memberId: pair.memberId,
        pairing: pair,
        credentialId: record.id,
        connectionId: connection.id,
        digest: this.proofDigest(call.id, code),
        attempts: 0,
        expiresAt: Math.min(this.now() + 120_000, this.verifyBy(call)!),
      });
      return { callId: call.id, code, expiresAt: proof.expiresAt };
    });
  }
  private slotCall() {
    const slot = this.slot();
    const call = slot
      ? this.store.get<SharedCall>(kind("call"), slot)
      : undefined;
    return call?.lineId === this.lineId ? this.expireIfDue(call) : undefined;
  }
  private waitingCall() {
    const call = this.slotCall();
    return call?.state === "unknown_identity" ? call : undefined;
  }
  /** The deadline for verification. A callback's window opens on answer. */
  verifyBy(call: SharedCall) {
    const start = call.callbackTaskId ? call.activatedAt : call.createdAt;
    return start === undefined ? undefined : start + UNVERIFIED_LIMIT_MS;
  }
  private expireIfDue(call: SharedCall) {
    const by = this.verifyBy(call);
    if (
      call.state !== "unknown_identity" ||
      by === undefined ||
      by > this.now()
    )
      return call;
    return this.release(call);
  }
  private release(call: SharedCall) {
    const proof = this.store.get<SharedCallProof>(kind("proof"), call.id);
    if (proof && proof.consumedAt === undefined)
      this.store.put(kind("proof"), { ...proof, consumedAt: this.now() });
    return this.store.put<SharedCall>(kind("call"), {
      ...call,
      state: "unauthorized",
      releasedAt: this.now(),
    });
  }
  /** The call that holds the slot but can no longer be verified: its window
   * passed, its attempts ran out, or its Mac was offline. The trusted line
   * adapter ends it by removing its room. The slot still frees only after the
   * observed provider cleanup, as for every call. */
  releaseUnverified() {
    return this.store.transaction(() => {
      const call = this.slotCall();
      return call && ["unauthorized", "offline"].includes(call.state)
        ? [
            {
              callId: call.id,
              providerCallId: call.providerCallId,
              roomId: call.roomId,
            },
          ]
        : [];
    });
  }
  /** The voice worker ends an unverified call in its room, for example at the
   * deadline it was given. An admitted call is never released this way. */
  releaseRoom(roomId: string) {
    return this.store.transaction(() => {
      const call = this.slotCall();
      if (!call || call.roomId !== roomId) return false;
      if (call.state === "unknown_identity") this.release(call);
      return ["unknown_identity", "unauthorized", "offline"].includes(
        call.state,
      );
    });
  }

  /** Caller binding is delivered by the authenticated call adapter, not model
   * tool arguments. No desktop is returned on a denial, replay or offline Mac. */
  async proveCall(evidence: unknown) {
    const binding = callProofTurnSchema.parse(
      await this.options.verifiers.callProofTurn(evidence),
    );
    if (binding.lineId !== this.lineId || binding.expiresAt <= this.now())
      throw refused();
    const callId = `shared_call_${hash(JSON.stringify([this.lineId, binding.providerCallId]))}`;
    const code = binding.code;
    return this.store.transaction(() => {
      const found = this.call(callId);
      if (
        found.providerCallId !== binding.providerCallId ||
        found.roomId !== binding.roomId ||
        found.participantId !== binding.participantId
      )
        throw refused();
      if (found.state !== "unknown_identity" || this.slot() !== found.id)
        throw refused();
      const call = this.expireIfDue(found);
      if (call.state !== "unknown_identity")
        return { state: "unauthorized" as const };
      const turnKey = `shared-proof-turn:${hash(JSON.stringify([call.id, binding.turnId]))}`;
      const fingerprint = this.proofDigest(call.id, stableEvidence(binding));
      const prior = this.store.event(turnKey);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw conflict();
        return { state: "unauthorized" as const };
      }
      const proof = this.store.get<SharedCallProof>(kind("proof"), call.id);
      if (!proof || proof.consumedAt !== undefined) throw refused();
      this.store.recordEvent(turnKey, fingerprint, { callId });
      const attempts = proof.attempts + 1;
      const valid =
        proof.expiresAt > this.now() &&
        attempts <= 5 &&
        /^\d{8}$/.test(code) &&
        equal(proof.digest, this.proofDigest(call.id, code));
      // Return denials instead of throwing: attempt/consumption must commit.
      this.store.put(kind("proof"), {
        ...proof,
        attempts,
        ...(valid || attempts >= 5 || proof.expiresAt <= this.now()
          ? { consumedAt: this.now() }
          : {}),
      });
      if (!valid) {
        if (attempts >= 5 || proof.expiresAt <= this.now())
          this.store.put(kind("call"), { ...call, state: "unauthorized" });
        return { state: "unauthorized" as const };
      }
      let pair: Pairing;
      try {
        pair = this.pairing(proof.memberId);
      } catch {
        this.store.put(kind("call"), { ...call, state: "unauthorized" });
        return { state: "unauthorized" as const };
      }
      if (JSON.stringify(pair) !== JSON.stringify(proof.pairing)) {
        this.store.put(kind("call"), { ...call, state: "unauthorized" });
        return { state: "unauthorized" as const };
      }
      const connection = this.connections.get(pair.deviceId);
      const original = call.callbackTaskId
        ? this.store.get<SharedTaskOwnership>(kind("task"), call.callbackTaskId)
        : undefined;
      if (
        call.callbackTaskId &&
        (!original ||
          original.scope.pairingId !== pair.id ||
          original.scope.deviceId !== pair.deviceId ||
          original.scope.desktopInstanceId !== connection?.desktopInstanceId)
      ) {
        this.store.put(kind("call"), { ...call, state: "unauthorized" });
        return { state: "unauthorized" as const };
      }
      if (!connection || connection.expiresAt <= this.now()) {
        this.store.put(kind("call"), { ...call, state: "offline" });
        return { state: "offline" as const };
      }
      // Admit only to the exact Mac connection that was shown the code.
      if (
        connection.id !== proof.connectionId ||
        connection.credentialId !== proof.credentialId
      ) {
        this.store.put(kind("call"), { ...call, state: "unauthorized" });
        return { state: "unauthorized" as const };
      }
      const admitted: SharedCall = {
        ...call,
        state: "admitted",
        authorizationExpiresAt: this.now() + 3_600_000,
        scope: {
          memberId: pair.memberId,
          pairingId: pair.id,
          deviceId: pair.deviceId,
          displayId: pair.displayId,
          desktopInstanceId: connection.desktopInstanceId,
          connectionId: connection.id,
          grantId: id("grant"),
          allowView: pair.allowView,
          allowControl: pair.allowControl,
          recipient: pair.recipient,
          conversationId: pair.conversationId,
        },
      };
      this.store.put(kind("call"), admitted);
      return { state: "admitted" as const, call: admitted };
    });
  }

  /** Recheck immediately before every remote operation and after model awaits.
   * This is routing authority only. Local Stop, fresh frames and exclusive
   * screen ownership remain mandatory in the existing Mac execution path. */
  authorizeCall(
    callId: string,
    grantId: string,
    permission: "view" | "control",
  ) {
    const call = this.call(callId),
      scope = call.scope;
    if (
      call.state !== "admitted" ||
      !scope ||
      scope.grantId !== grantId ||
      this.slot() !== call.id ||
      !call.authorizationExpiresAt ||
      call.authorizationExpiresAt <= this.now()
    )
      throw refused();
    const pair = this.pairing(scope.memberId);
    const connection = this.connections.get(pair.deviceId);
    if (
      pair.id !== scope.pairingId ||
      pair.deviceId !== scope.deviceId ||
      pair.displayId !== scope.displayId ||
      !connection ||
      connection.id !== scope.connectionId ||
      connection.desktopInstanceId !== scope.desktopInstanceId ||
      connection.expiresAt <= this.now()
    )
      throw refused();
    if (
      !pair.allowView ||
      !scope.allowView ||
      (permission === "control" && (!pair.allowControl || !scope.allowControl))
    )
      throw refused();
    return call;
  }

  /** Must be committed before starting the task. Stable IDs originate in the
   * authenticated user-turn path, never timestamp/latest-job inference. */
  createTask(
    callId: string,
    grantId: string,
    input: {
      taskId: string;
      userTurnId: string;
      requestDigest: string;
      callbackRequested?: boolean;
    },
  ) {
    const parsed = z
      .object({
        taskId: routingId,
        userTurnId: routingId,
        requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
        callbackRequested: z.boolean().optional(),
      })
      .strict()
      .parse(input);
    return this.store.transaction(() => {
      const call = this.authorizeCall(callId, grantId, "control");
      const existing = this.store.get<SharedTaskOwnership>(
        kind("task"),
        parsed.taskId,
      );
      if (existing) {
        if (
          existing.callId !== call.id ||
          existing.userTurnId !== parsed.userTurnId ||
          existing.requestDigest !== parsed.requestDigest
        )
          throw conflict();
        return existing;
      }
      if (
        this.store
          .all<SharedTaskOwnership>(kind("task"))
          .some(
            (task) =>
              task.callId === call.id && task.userTurnId === parsed.userTurnId,
          )
      )
        throw conflict();
      return this.store.put<SharedTaskOwnership>(kind("task"), {
        id: parsed.taskId,
        callId: call.id,
        lineId: call.lineId,
        providerCallId: call.providerCallId,
        scope: call.scope!,
        userTurnId: parsed.userTurnId,
        requestDigest: parsed.requestDigest,
        callbackRequested: parsed.callbackRequested === true,
        createdAt: this.now(),
      });
    });
  }

  /** Completion can arrive after hangup, but only from the original device
   * and desktop instance. Reconnection never changes the task's owner. */
  completeTask(
    credential: string,
    connectionId: string,
    taskId: string,
    resultId: string,
  ) {
    routingId.parse(resultId);
    return this.store.transaction(() => {
      const connection = this.connection(credential, connectionId);
      const task = this.store.get<SharedTaskOwnership>(kind("task"), taskId);
      if (
        !task ||
        task.lineId !== this.lineId ||
        task.scope.memberId !== connection.memberId ||
        task.scope.pairingId !== connection.pairingId ||
        task.scope.deviceId !== connection.deviceId ||
        task.scope.desktopInstanceId !== connection.desktopInstanceId
      )
        throw refused();
      if (task.resultId && task.resultId !== resultId) throw conflict();
      const callbackId = `shared_callback_${hash(JSON.stringify([task.id, resultId]))}`;
      const prior = this.store.get<SharedCallbackOwnership>(
        kind("callback"),
        callbackId,
      );
      if (prior) return prior;
      this.store.put(kind("task"), { ...task, resultId });
      return this.store.put<SharedCallbackOwnership>(kind("callback"), {
        id: callbackId,
        taskId: task.id,
        resultId,
        callId: task.callId,
        lineId: task.lineId,
        scope: task.scope,
        state: "queued",
        createdAt: this.now(),
      });
    });
  }
  requestCallback(callId: string, grantId: string, taskId: string) {
    return this.store.transaction(() => {
      this.authorizeCall(callId, grantId, "control");
      const task = this.store.get<SharedTaskOwnership>(kind("task"), taskId);
      if (!task || task.callId !== callId) throw refused();
      this.store.put(kind("task"), { ...task, callbackRequested: true });
      return { ok: true };
    });
  }
  /** Reserve the same durable slot used by inbound admissions before handoff.
   * The original explicit request, pairing and desktop lifetime must survive. */
  hasQueuedCallback() {
    return (
      !this.slot() &&
      this.store
        .all<SharedCallbackOwnership>(kind("callback"))
        .some(
          (c) =>
            c.state === "queued" &&
            this.store.get<SharedTaskOwnership>(kind("task"), c.taskId)
              ?.callbackRequested,
        )
    );
  }
  claimCallback() {
    return this.store.transaction(() => {
      if (this.slot()) return null;
      for (const callback of this.store.all<SharedCallbackOwnership>(
        kind("callback"),
      )) {
        if (callback.state !== "queued") continue;
        const task = this.store.get<SharedTaskOwnership>(
          kind("task"),
          callback.taskId,
        );
        if (!task?.callbackRequested) continue;
        let pair: Pairing;
        try {
          pair = this.pairing(callback.scope.memberId);
        } catch {
          this.store.put(kind("callback"), { ...callback, state: "canceled" });
          continue;
        }
        if (
          pair.id !== callback.scope.pairingId ||
          task.createdAt + 43_200_000 <= this.now()
        ) {
          this.store.put(kind("callback"), { ...callback, state: "canceled" });
          continue;
        }
        const connection = this.connections.get(callback.scope.deviceId);
        if (
          !connection ||
          connection.expiresAt <= this.now() ||
          connection.desktopInstanceId !== callback.scope.desktopInstanceId
        )
          continue;
        const claimed: SharedCallbackOwnership = {
          ...callback,
          state: "preparing",
          roomId: `callback_${hash(callback.id)}`,
        };
        this.store.put(kind("callback"), claimed);
        this.store.saveState(this.slotKey(), callback.id);
        return claimed;
      }
      return null;
    });
  }
  callback(id: string) {
    const callback = this.store.get<SharedCallbackOwnership>(
      kind("callback"),
      id,
    );
    if (!callback || callback.lineId !== this.lineId) throw refused();
    return callback;
  }
  callbackDialing(id: string) {
    return this.store.transaction(() => {
      const callback = this.callback(id);
      if (callback.state !== "preparing" || this.slot() !== callback.id)
        throw conflict();
      // Recheck ownership after preparation, immediately before dial submission.
      const pair = this.pairing(callback.scope.memberId);
      const connection = this.connections.get(callback.scope.deviceId);
      if (
        pair.id !== callback.scope.pairingId ||
        !connection ||
        connection.expiresAt <= this.now() ||
        connection.desktopInstanceId !== callback.scope.desktopInstanceId
      )
        throw refused();
      return this.store.put<SharedCallbackOwnership>(kind("callback"), {
        ...callback,
        state: "dialing",
      });
    });
  }
  bindCallback(id: string, providerCallId: string) {
    routingId.parse(providerCallId);
    return this.store.transaction(() => {
      const callback = this.callback(id);
      if (
        callback.state === "active" &&
        callback.providerCallId === providerCallId
      )
        return this.call(callback.outboundCallId!);
      if (
        callback.state !== "dialing" ||
        this.slot() !== callback.id ||
        !callback.roomId
      )
        throw conflict();
      const callId = `shared_call_${hash(JSON.stringify([this.lineId, providerCallId]))}`;
      if (this.store.get(kind("call"), callId)) throw conflict();
      const call = this.store.put<SharedCall>(kind("call"), {
        id: callId,
        lineId: this.lineId,
        providerCallId,
        roomId: callback.roomId,
        participantId: "shared-bridge",
        state: "unknown_identity",
        createdAt: this.now(),
        expectedMemberId: callback.scope.memberId,
        callbackTaskId: callback.taskId,
      });
      this.store.put<SharedCallbackOwnership>(kind("callback"), {
        ...callback,
        state: "active",
        providerCallId,
        outboundCallId: call.id,
      });
      this.store.saveState(this.slotKey(), call.id);
      return call;
    });
  }
  activateCallback(id: string) {
    const callback = this.callback(id);
    if (callback.state !== "active" || !callback.outboundCallId)
      throw refused();
    const call = this.call(callback.outboundCallId);
    if (!["unknown_identity", "admitted"].includes(call.state)) throw refused();
    if (!call.activatedAt)
      this.store.put(kind("call"), { ...call, activatedAt: this.now() });
  }
  walkthrough(callId: string, grantId: string) {
    const call = this.authorizeCall(callId, grantId, "view");
    const task = call.callbackTaskId
      ? this.store.get<SharedTaskOwnership>(kind("task"), call.callbackTaskId)
      : undefined;
    if (
      !task?.resultId ||
      task.scope.memberId !== call.scope!.memberId ||
      task.scope.deviceId !== call.scope!.deviceId ||
      task.scope.desktopInstanceId !== call.scope!.desktopInstanceId
    )
      throw refused();
    return { taskId: task.id, resultId: task.resultId };
  }
  callbackUnknown(id: string) {
    const callback = this.callback(id);
    if (["ended", "canceled"].includes(callback.state)) return;
    this.store.put(kind("callback"), { ...callback, state: "unknown" });
    if (callback.outboundCallId) {
      const call = this.call(callback.outboundCallId);
      this.store.put(kind("call"), { ...call, state: "outcome_unknown" });
    }
  }
  /** Trusted adapter calls only after provider terminal, room absence and
   * incoming-owner restoration are all independently observed. */
  callbackClean(id: string) {
    return this.store.transaction(() => {
      const callback = this.callback(id);
      if (callback.state === "ended") return;
      if (["queued", "canceled"].includes(callback.state)) throw conflict();
      if (callback.outboundCallId) {
        const call = this.call(callback.outboundCallId);
        this.store.put(kind("call"), {
          ...call,
          state: "ended",
          cleanupAt: this.now(),
        });
      }
      if ([callback.id, callback.outboundCallId].includes(this.slot() ?? ""))
        this.store.saveState(this.slotKey(), null);
      this.store.put(kind("callback"), { ...callback, state: "ended" });
    });
  }
}
