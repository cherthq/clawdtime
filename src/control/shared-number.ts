import { createHmac, randomInt } from "node:crypto";
import { z } from "zod";
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
  type SharedPairing,
} from "../shared-number-contracts.js";
import type { SQLInputValue } from "node:sqlite";
import { Store } from "../storage/store.js";
import { DomainError, equal, hash, id, token } from "../storage/security.js";
import { SharedNumberKeys } from "../pairing/shared-number-keys.js";

type Pairing = SharedPairing;

interface Invitation {
  id: string;
  memberId: string;
  expiresAt: number;
  consumedAt?: number;
  // An explicit replacement names the pairing it replaces.
  replace?: boolean;
  replacesPairingId?: string;
}
const kind = (name: string) => `shared_number_${name}`;
/** A caller who has not verified within this time is released, so one
 * unverified call cannot hold the single line slot. */
export const UNVERIFIED_LIMIT_MS = 90_000;
/** A callback whose claim ended before any dial is tried again this many
 * times in all, after a pause that doubles from 30 s, then canceled. */
const UNDIALED_TRIES = 5;
/** One caller handle may hold the slot without verifying this many times in
 * the window. Someone who sends a member's number cannot hold the line. */
const CALLER_LIMIT = { count: 5, windowMs: 60 * 60_000 };
// Each query of a large kind reads one of these, never every record of it.
const indexes: [name: string, path: string][] = [
  ["call", "$.state"],
  ["call", "$.roomId"],
  ["call", "$.callerDigest"],
  ["callback", "$.state"],
  ["callback", "$.roomId"],
  ["task", "$.callId"],
  ["credential", "$.pairingId"],
  ["member", "$.alias.recipientDigest"],
  ["member", "$.alias.conversationDigest"],
];
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
  private readonly keys: SharedNumberKeys;
  constructor(
    private readonly store: Store,
    private readonly options: {
      lineId: string;
      proofKey: string;
      /** The key of the numbers' digests and sealed copies, the same as the
       * phone sign-in's, so a caller handle matches a member's number. */
      identityKey: string;
      verifiers: SharedNumberVerifiers;
      now?: () => number;
    },
  ) {
    this.lineId = routingId.parse(options.lineId);
    if (!/^[a-f0-9]{64}$/i.test(options.proofKey))
      throw new Error("Shared routing needs a separate 32-byte proof key.");
    this.keys = new SharedNumberKeys(options.identityKey, this.lineId);
    this.now = options.now ?? Date.now;
    for (const [name, path] of indexes)
      this.store.db.exec(
        `CREATE INDEX IF NOT EXISTS ${kind(name)}_${path.replace(/\W/g, "_")}
         ON entities(kind, json_extract(body, '${path}'))
         WHERE kind = '${kind(name)}'`,
      );
    this.migrate();
    // A restart cannot resume a desktop admission from an old connection.
    // Keep the slot reserved until exact provider cleanup is reconciled.
    this.store.transaction(() => {
      for (const call of this.select<SharedCall>(
        "call",
        "json_extract(body, '$.state') = 'admitted'",
      )) {
        if (call.lineId === this.lineId)
          this.store.put(kind("call"), { ...call, state: "outcome_unknown" });
      }
    });
  }
  /** Records of one kind that match a condition on an indexed field. */
  private select<T>(name: string, where: string, ...values: SQLInputValue[]) {
    return this.store.db
      .prepare(
        `SELECT body FROM entities WHERE kind = '${kind(name)}' AND ${where}
         ORDER BY rowid`,
      )
      .all(...values)
      .map((row) => JSON.parse(String(row.body)) as T);
  }

  /** Rows from an earlier release kept numbers in the clear. Keep their keyed
   * digests, and the member's number sealed for callbacks. The same function
   * turns a pairing and its proof snapshot, so the two still match. */
  private migrate() {
    const digests = (value: Record<string, unknown>) => {
      const { recipient, conversationId, ...rest } = value;
      return {
        ...rest,
        recipientDigest: this.keys.digest(String(recipient)),
        conversationDigest: this.keys.digest(String(conversationId)),
      } as Record<string, unknown> as { id: string };
    };
    const legacy = (name: string, path: string) =>
      this.store.db
        .prepare(
          `SELECT body FROM entities WHERE kind = ?
           AND json_extract(body, ?) IS NOT NULL`,
        )
        .all(kind(name), path)
        .map((row) => JSON.parse(String(row.body)));
    this.store.transaction(() => {
      for (const member of legacy("member", "$.alias.recipient"))
        this.store.put(kind("member"), {
          ...member,
          alias: digests(member.alias),
          // A banned member is never called back.
          ...(member.revokedAt === undefined
            ? { sealedRecipient: this.keys.seal(member.alias.recipient) }
            : {}),
        });
      for (const pairing of legacy("pairing", "$.recipient"))
        this.store.put(kind("pairing"), digests(pairing));
      for (const proof of legacy("proof", "$.pairing.recipient"))
        this.store.put(kind("proof"), {
          ...proof,
          pairing: digests(proof.pairing),
        });
      for (const name of ["call", "task", "callback"])
        for (const row of legacy(name, "$.scope.recipient"))
          this.store.put(kind(name), { ...row, scope: digests(row.scope) });
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
    const recipientDigest = this.keys.digest(alias.recipient);
    const conversationDigest = this.keys.digest(alias.conversationId);
    return this.store.transaction(() => {
      const old = this.store.get<SharedMember>(
        kind("member"),
        account.memberId,
      );
      if (old) {
        if (
          old.revokedAt !== undefined ||
          old.alias.recipientDigest !== recipientDigest ||
          old.alias.conversationDigest !== conversationDigest ||
          old.alias.lineId !== alias.lineId
        )
          throw conflict();
        if (old.sealedRecipient) return old;
        return this.store.put<SharedMember>(kind("member"), {
          ...old,
          sealedRecipient: this.keys.seal(alias.recipient),
        });
      }
      // An alias never silently moves between accounts, including revoked ones.
      if (
        this.store.db
          .prepare(
            `SELECT 1 FROM entities WHERE kind = '${kind("member")}'
             AND json_extract(body, '$.alias.lineId') = ?
             AND (json_extract(body, '$.alias.recipientDigest') = ?
               OR json_extract(body, '$.alias.conversationDigest') = ?)
             LIMIT 1`,
          )
          .get(alias.lineId, recipientDigest, conversationDigest)
      )
        throw conflict();
      return this.store.put<SharedMember>(kind("member"), {
        id: account.memberId,
        alias: {
          memberId: alias.memberId,
          lineId: alias.lineId,
          recipientDigest,
          conversationDigest,
          expiresAt: alias.expiresAt,
        },
        sealedRecipient: this.keys.seal(alias.recipient),
      });
    });
  }

  /** One selected Mac per member, with no implicit replacement. A member who
   * lost a Mac, or whose device credential was stolen, asks for an explicit
   * replacement: accepting it on the new Mac revokes the old pairing. */
  async invite(accountProof: unknown, options: { replace?: boolean } = {}) {
    const account = await this.account(accountProof);
    return this.store.transaction(() => {
      const member = this.member(account.memberId);
      if (member.pairingId && options.replace !== true) throw conflict();
      const secret = token();
      const invitation = this.store.put<Invitation>(kind("invite"), {
        id: hash(secret),
        memberId: member.id,
        expiresAt: this.now() + 300_000,
        ...(member.pairingId
          ? { replace: true, replacesPairingId: member.pairingId }
          : {}),
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
      // The pairing must still be the one this invitation was issued against.
      if (member.pairingId !== invite.replacesPairingId) throw conflict();
      if (member.pairingId) this.unpair(member);
      const pair: Pairing = {
        id: id("pair"),
        memberId: member.id,
        lineId: this.lineId,
        recipientDigest: member.alias.recipientDigest,
        conversationDigest: member.alias.conversationDigest,
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
  /** Revoke unpairs the Mac and revokes its credentials. The number stays
   * enrolled and can pair again, so one sign-in code alone never bans it. A
   * permanent ban is the member's own request: it needs the signed-in account
   * and the current credential of the paired Mac together. */
  async revoke(
    accountProof: unknown,
    options: { permanent?: boolean; deviceCredential?: string } = {},
  ) {
    const account = await this.account(accountProof);
    this.store.transaction(() => {
      const member = this.member(account.memberId);
      if (options.permanent) {
        const { pair } = this.authenticate(options.deviceCredential ?? "");
        if (pair.memberId !== member.id || pair.id !== member.pairingId)
          throw refused();
      }
      const unpaired = this.unpair(member);
      // A banned member is never called back, so the sealed number goes.
      const { sealedRecipient: _sealed, ...banned } = unpaired;
      if (options.permanent)
        this.store.put(kind("member"), {
          ...banned,
          revokedAt: this.now(),
        });
    });
  }
  private unpair(member: SharedMember) {
    if (!member.pairingId) return member;
    const pair = this.store.get<Pairing>(kind("pairing"), member.pairingId);
    if (pair) {
      if (pair.revokedAt === undefined)
        this.store.put(kind("pairing"), { ...pair, revokedAt: this.now() });
      for (const c of this.select<SharedDeviceCredential>(
        "credential",
        "json_extract(body, '$.pairingId') = ?",
        pair.id,
      ))
        if (c.pairingId === pair.id && c.revokedAt === undefined)
          this.store.put(kind("credential"), { ...c, revokedAt: this.now() });
      this.fenceDevice(pair.deviceId);
    }
    const { pairingId: _pairingId, ...rest } = member;
    return this.store.put<SharedMember>(kind("member"), rest);
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
    for (const call of this.select<SharedCall>(
      "call",
      "json_extract(body, '$.state') = 'admitted'",
    ))
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
      // The receipt fingerprints the caller only by its keyed digest.
      const fingerprint = hash(
        stableEvidence(
          event.kind === "incoming" && event.caller
            ? { ...event, caller: this.callerDigest(event.caller) }
            : event,
        ),
      );
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
        const callerDigest = event.caller
          ? this.callerDigest(event.caller)
          : undefined;
        call = old ?? {
          id: callId,
          lineId: this.lineId,
          providerCallId: event.providerCallId,
          roomId: event.roomId,
          participantId: event.participantId,
          state: this.admission(event.caller, callerDigest),
          createdAt: this.now(),
          ...(callerDigest ? { callerDigest } : {}),
        };
        if (!old && call.state === "unknown_identity")
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
  /** A call reserves the slot only when a paired Mac could be shown its
   * code: the caller handle is a member's verified number and that member
   * has a paired Mac. Every other call, with no handle or anyone else's, is
   * declined at once. So is a caller over its limit of unverified calls. */
  private admission(caller?: string, callerDigest?: string) {
    if (!caller || !callerDigest || !this.callerHasMac(caller))
      return "declined" as const;
    if (this.slot()) return "busy" as const;
    const recent = this.store.db
      .prepare(
        `SELECT count(*) AS n FROM entities WHERE kind = '${kind("call")}'
         AND json_extract(body, '$.callerDigest') = ?
         AND json_extract(body, '$.createdAt') > ?
         AND json_extract(body, '$.scope') IS NULL
         AND json_extract(body, '$.state') NOT IN ('busy', 'declined')`,
      )
      .get(callerDigest, this.now() - CALLER_LIMIT.windowMs) as { n: number };
    return recent.n >= CALLER_LIMIT.count
      ? ("declined" as const)
      : ("unknown_identity" as const);
  }
  private callerHasMac(caller: string) {
    const rows = this.store.db
      .prepare(
        `SELECT id FROM entities WHERE kind = '${kind("member")}'
         AND json_extract(body, '$.alias.lineId') = ?
         AND json_extract(body, '$.alias.recipientDigest') = ?
         AND json_extract(body, '$.revokedAt') IS NULL`,
      )
      .all(this.lineId, this.callerDigest(caller)) as { id: string }[];
    return rows.some(({ id }) => {
      try {
        this.pairing(id);
        return true;
      } catch {
        return false;
      }
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
    return this.keys.digest(handle);
  }
  /** Only the member whose verified number placed the call may be shown its
   * code. A callback is bound to its original member instead. Selection only:
   * the code from the paired Mac still has to be spoken on this call. */
  private callerIs(call: SharedCall, memberId: string) {
    if (call.expectedMemberId) return call.expectedMemberId === memberId;
    if (!call.callerDigest) return false;
    const member = this.member(memberId);
    return equal(call.callerDigest, member.alias.recipientDigest);
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
      // A callback has no verification window, and no code, until answered.
      const verifyBy = this.verifyBy(call);
      if (verifyBy === undefined) throw notWaiting();
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
        expiresAt: Math.min(this.now() + 120_000, verifyBy),
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
  /** The open call or callback of one room, for the trusted voice worker. */
  room(roomId: string) {
    return {
      calls: this.select<SharedCall>(
        "call",
        `json_extract(body, '$.roomId') = ?
         AND json_extract(body, '$.state') IN ('unknown_identity', 'admitted')`,
        roomId,
      ).filter((call) => call.lineId === this.lineId),
      callbacks: this.select<SharedCallbackOwnership>(
        "callback",
        `json_extract(body, '$.roomId') = ?
         AND json_extract(body, '$.state') IN ('preparing', 'dialing')`,
        roomId,
      ).filter((callback) => callback.lineId === this.lineId),
    };
  }
  /** Ended, busy and declined calls leave no work. Ended before `before`,
   * they go with their proof, their event receipts and their room's voice
   * claim. Open, released and unknown calls always stay. */
  prune(before: number, limit = 1000) {
    return this.store.transaction(() => {
      const slot = this.slot();
      const rows = (
        this.store.db
          .prepare(
            `SELECT id, json_extract(body, '$.roomId') AS roomId
             FROM entities WHERE kind = '${kind("call")}'
             AND json_extract(body, '$.state') IN ('ended', 'busy', 'declined')
             AND coalesce(json_extract(body, '$.cleanupAt'),
               json_extract(body, '$.createdAt')) <= ?
             LIMIT ?`,
          )
          .all(before, limit) as { id: string; roomId: string }[]
      ).filter((row) => row.id !== slot);
      const ids = JSON.stringify(rows.map((row) => row.id));
      this.store.db
        .prepare(
          `DELETE FROM entities WHERE kind IN ('${kind("call")}', '${kind("proof")}')
           AND id IN (SELECT value FROM json_each(?))`,
        )
        .run(ids);
      this.store.db
        .prepare(
          `DELETE FROM entities WHERE kind = 'shared_voice_claim'
           AND id IN (SELECT value FROM json_each(?))`,
        )
        .run(JSON.stringify(rows.map((row) => row.roomId)));
      // Only this router's receipts: provider events and proof turns.
      this.store.db
        .prepare(
          `DELETE FROM events
           WHERE ((id >= 'shared-provider:' AND id < 'shared-provider;')
             OR (id >= 'shared-proof-turn:' AND id < 'shared-proof-turn;'))
           AND json_extract(result, '$.callId') IN (SELECT value FROM json_each(?))`,
        )
        .run(ids);
      return rows.map((row) => row.id);
    });
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
          recipientDigest: pair.recipientDigest,
          conversationDigest: pair.conversationDigest,
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
        this.select<SharedTaskOwnership>(
          "task",
          "json_extract(body, '$.callId') = ?",
          call.id,
        ).some(
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
      this.select<SharedCallbackOwnership>(
        "callback",
        "json_extract(body, '$.state') = 'queued'",
      ).some(
        (c) =>
          c.state === "queued" &&
          (c.notBefore ?? 0) <= this.now() &&
          this.store.get<SharedTaskOwnership>(kind("task"), c.taskId)
            ?.callbackRequested,
      )
    );
  }
  claimCallback() {
    return this.store.transaction(() => {
      if (this.slot()) return null;
      for (const callback of this.select<SharedCallbackOwnership>(
        "callback",
        "json_extract(body, '$.state') = 'queued'",
      )) {
        if (callback.state !== "queued") continue;
        if ((callback.notBefore ?? 0) > this.now()) continue;
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
        // A new room for each try: the voice worker of an earlier try may
        // still hold the earlier room.
        const claimed: SharedCallbackOwnership = {
          ...callback,
          state: "preparing",
          roomId: `callback_${hash(
            callback.undialed
              ? JSON.stringify([callback.id, callback.undialed])
              : callback.id,
          )}`,
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
  /** The number a callback dials: the member's sealed number, opened only for
   * the dial. It must still be the number that the call's pairing verified. */
  callbackRecipient(id: string) {
    const callback = this.callback(id);
    const member = this.member(callback.scope.memberId);
    if (!member.sealedRecipient) throw refused();
    const recipient = this.keys.open(member.sealedRecipient);
    if (!equal(this.keys.digest(recipient), callback.scope.recipientDigest))
      throw refused();
    return recipient;
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
  /** The claim ended before any dial, and its room is gone: nothing reached
   * the provider. The callback goes back in the queue after a pause, or is
   * canceled after its last try, and the slot frees. */
  callbackUndialed(id: string) {
    return this.store.transaction(() => {
      const callback = this.callback(id);
      // A stop after the requeue, before its attempt was saved, repeats it.
      if (["queued", "canceled"].includes(callback.state)) return callback;
      if (!["preparing", "dialing"].includes(callback.state)) throw conflict();
      const undialed = (callback.undialed ?? 0) + 1;
      if (this.slot() === callback.id)
        this.store.saveState(this.slotKey(), null);
      return this.store.put<SharedCallbackOwnership>(kind("callback"), {
        ...callback,
        state: undialed >= UNDIALED_TRIES ? "canceled" : "queued",
        undialed,
        notBefore: this.now() + 30_000 * 2 ** (undialed - 1),
      });
    });
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
