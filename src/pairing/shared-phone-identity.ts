import { createHmac, randomInt } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { z } from "zod";
import { Store } from "../storage/store.js";
import { DomainError, equal, hash, token } from "../storage/security.js";
import { SharedNumberKeys } from "./shared-number-keys.js";

interface Challenge {
  id: string;
  /** Keyed digest of the number, never the number itself. */
  number: string;
  /** The number, sealed, only while a texted code can still verify it. */
  sealed?: string;
  /** Keyed digest of the client address, never the address itself. */
  client?: string;
  /** False when no text was sent: the number is not invited or a member. */
  eligible?: boolean;
  /** True when this client signed in to this number before. */
  known?: boolean;
  digest: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  state: "sending" | "sent" | "unknown" | "consumed" | "withheld";
}
interface Session {
  id: string;
  memberId: string;
  /** Keyed digest of the number, and the number sealed for enrollment. */
  number: string;
  sealed: string;
  expiresAt: number;
}
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/);
const denied = () => new DomainError(403, "identity_refused");
const challenges = "shared_identity_challenge";
const sessions = "shared_identity_session";
const minute = 60_000;
// One client, and one number from one client, each have their own allowance,
// so one abuser cannot spend a member's. Clients that never signed in to a
// number share that number's allowance. A client that signed in to it before
// has a separate one, which other clients cannot spend, so the member's own
// client stays open. Together they bound the texts to one number to 15 an
// hour. The text ceiling bounds the line. Only real texts count for the line.
const limits = {
  numberFromClient: { count: 3, window: 10 * minute },
  client: { count: 10, window: 60 * minute },
  number: { count: 5, window: 60 * minute },
  knownNumber: { count: 10, window: 60 * minute },
  texts: { count: 100, window: 60 * minute },
};
// A challenge older than every window is expired and counts for nothing.
const kept = 60 * minute;
// A client that signed in to a number stays known to it for this long.
const knownFor = 30 * 24 * 60 * minute;
const knownClients = "shared_identity_known_client";

const proxies = new BlockList();
for (const [subnet, bits] of [
  ["127.0.0.0", 8],
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10],
  ["169.254.0.0", 16],
] as const)
  proxies.addSubnet(subnet, bits, "ipv4");
proxies.addAddress("::1", "ipv6");
proxies.addSubnet("fc00::", 7, "ipv6");
proxies.addSubnet("fe80::", 10, "ipv6");
const plain = (address: string) =>
  address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
const prefix64 = (address: string) => {
  const [head = "", tail] = address.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups =
    tail === undefined
      ? left
      : [
          ...left,
          ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill(
            "0",
          ),
          ...right,
        ];
  return `${groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(":")}::/64`;
};

/** The rate-limit key of one sign-in client. A loopback or private peer is the
 * HTTPS proxy of the setup guide, so the last X-Forwarded-For entry, which that
 * proxy added, names the client. A public peer is the client itself. An IPv6
 * client counts by its /64, which one person can rotate within. */
export function signInClient(peer?: string, forwarded?: string) {
  if (!peer || !isIP(plain(peer))) return "unknown";
  let address = plain(peer);
  const family = (value: string) => (isIP(value) === 6 ? "ipv6" : "ipv4");
  if (forwarded && proxies.check(address, family(address))) {
    const last = plain(forwarded.split(",").at(-1)?.trim() ?? "");
    if (isIP(last)) address = last;
  }
  return isIP(address) === 6 ? prefix64(address) : address;
}

/** Passwordless phone possession proof. Only the requested recipient receives
 * the code, and only when the operator invited that number or it belongs to a
 * current member. Every other number gets the same answer and no text. No
 * inbound masked sender or caller metadata is treated as identity. Delivery
 * and verification have separate durable receipts and bounded rates. */
export class SharedPhoneIdentity {
  private readonly invited: ReadonlySet<string>;
  private readonly keys: SharedNumberKeys;
  constructor(
    private store: Store,
    private options: {
      lineId: string;
      key: string;
      /** Exact numbers the operator invites. Current members need no entry. */
      invited?: readonly string[];
      now?: () => number;
      send(
        recipient: string,
        code: string,
        idempotencyKey: string,
      ): Promise<boolean>;
    },
  ) {
    if (!/^[a-f0-9]{64}$/i.test(options.key))
      throw Error("identity_key_required");
    const invited = options.invited ?? [];
    if (!invited.every((number) => phone.safeParse(number).success))
      throw Error("identity_invited_number_invalid");
    this.invited = new Set(invited);
    this.keys = new SharedNumberKeys(options.key, options.lineId);
    for (const [name, path] of [
      [challenges, "$.createdAt"],
      [sessions, "$.expiresAt"],
      [knownClients, "$.verifiedAt"],
    ] as const)
      store.db.exec(
        `CREATE INDEX IF NOT EXISTS ${name}_${path.slice(2)}
         ON entities(kind, json_extract(body, '${path}'))
         WHERE kind = '${name}'`,
      );
    this.migrate();
  }
  /** Rows from an earlier release kept the number in the clear. Keep only
   * its keyed digest, and a sealed copy where a code can still verify it. */
  private migrate() {
    const legacy = (kind: string) =>
      this.store.db
        .prepare(
          `SELECT body FROM entities WHERE kind = ?
           AND json_extract(body, '$.recipient') IS NOT NULL`,
        )
        .all(kind)
        .map((row) => JSON.parse(String(row.body)));
    this.store.transaction(() => {
      const now = this.now();
      for (const { recipient, ...rest } of legacy(challenges)) {
        const open =
          rest.eligible !== false &&
          rest.state !== "consumed" &&
          rest.expiresAt > now;
        this.store.put<Challenge>(challenges, {
          ...rest,
          number: this.keys.digest(recipient),
          ...(open ? { sealed: this.keys.seal(recipient) } : {}),
        });
      }
      for (const { recipient, ...rest } of legacy(sessions))
        this.store.put<Session>(sessions, {
          ...rest,
          number: this.keys.digest(recipient),
          sealed: this.keys.seal(recipient),
        });
    });
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private digest(...values: string[]) {
    return createHmac("sha256", Buffer.from(this.options.key, "hex"))
      .update(JSON.stringify(values))
      .digest("hex");
  }
  /** Invited, or a current member of this line (see SharedMember). */
  private eligible(recipient: string) {
    return (
      this.invited.has(recipient) ||
      this.store.db
        .prepare(
          `SELECT 1 FROM entities WHERE kind = 'shared_number_member'
           AND json_extract(body, '$.alias.lineId') = ?
           AND json_extract(body, '$.alias.recipientDigest') = ?
           AND json_extract(body, '$.revokedAt') IS NULL LIMIT 1`,
        )
        .get(this.options.lineId, this.keys.digest(recipient)) !== undefined
    );
  }
  async start(raw: string, client = "unknown") {
    const recipient = phone.parse(raw);
    const code = randomInt(100_000_000).toString().padStart(8, "0");
    const now = this.now();
    const challenge = this.store.transaction(() => {
      this.store.db
        .prepare(
          `DELETE FROM entities WHERE kind = '${challenges}'
           AND json_extract(body, '$.createdAt') <= ?`,
        )
        .run(now - kept);
      this.store.db
        .prepare(
          `DELETE FROM entities WHERE kind = '${knownClients}'
           AND json_extract(body, '$.verifiedAt') <= ?`,
        )
        .run(now - knownFor);
      // An expired code can no longer verify: drop its sealed number.
      this.store.db
        .prepare(
          `UPDATE entities SET body = json_remove(body, '$.sealed')
           WHERE kind = '${challenges}'
           AND json_extract(body, '$.expiresAt') <= ?
           AND json_extract(body, '$.sealed') IS NOT NULL`,
        )
        .run(now);
      this.store.db
        .prepare(
          `DELETE FROM entities WHERE kind = '${sessions}'
           AND json_extract(body, '$.expiresAt') <= ?`,
        )
        .run(now);
      const number = this.keys.digest(recipient);
      const from = this.digest("client", client);
      const eligible = this.eligible(recipient);
      const known =
        this.store.get(knownClients, this.digest("known", from, number)) !==
        undefined;
      const used = this.store.db
        .prepare(
          `SELECT coalesce(sum(client = ?1), 0) AS client,
             coalesce(sum(client = ?1 AND number = ?2 AND createdAt > ?3), 0) AS numberFromClient,
             coalesce(sum(number = ?2 AND known = 0), 0) AS number,
             coalesce(sum(number = ?2 AND known = 1), 0) AS knownNumber,
             coalesce(sum(eligible), 0) AS texts
           FROM (SELECT json_extract(body, '$.client') AS client,
               json_extract(body, '$.number') AS number,
               json_extract(body, '$.createdAt') AS createdAt,
               coalesce(json_extract(body, '$.eligible'), 1) AS eligible,
               coalesce(json_extract(body, '$.known'), 0) AS known
             FROM entities WHERE kind = '${challenges}'
             AND json_extract(body, '$.createdAt') > ?4)`,
        )
        .get(
          from,
          number,
          now - limits.numberFromClient.window,
          now - kept,
        ) as Record<keyof typeof limits, number>;
      // A known client uses its own allowance for this number, never the
      // allowance of the clients that share it.
      const checked = (Object.keys(limits) as (keyof typeof limits)[]).filter(
        (name) => name !== (known ? "number" : "knownNumber"),
      );
      // The text ceiling refuses every start, so a stranger's answer matches.
      if (checked.some((name) => used[name] >= limits[name].count))
        throw new DomainError(429, "identity_rate_limited");
      const id = token();
      // A stranger's challenge keeps only the digest, for its limits.
      return this.store.put<Challenge>(challenges, {
        id,
        number,
        ...(eligible ? { sealed: this.keys.seal(recipient) } : {}),
        client: from,
        eligible,
        ...(known ? { known } : {}),
        digest: this.digest(id, code),
        createdAt: now,
        expiresAt: now + 300_000,
        attempts: 0,
        state: eligible ? "sending" : "withheld",
      });
    });
    // The answer never waits for the provider, so its timing does not tell
    // a member from anyone else.
    if (challenge.eligible) void this.deliver(challenge, recipient, code);
    return { challengeId: challenge.id, expiresAt: challenge.expiresAt };
  }
  /** The number is sent from memory here. It is never read back to send. */
  private async deliver(challenge: Challenge, recipient: string, code: string) {
    let sent = false;
    try {
      sent = await this.options.send(
        recipient,
        code,
        `shared-verify-${challenge.id}`,
      );
    } catch {
      /* A timeout is unknown, never evidence to resend. */
    }
    try {
      this.store.transaction(() => {
        const current = this.store.get<Challenge>(challenges, challenge.id);
        // Verification may already have consumed it; never undo that.
        if (current?.state === "sending")
          this.store.put(challenges, {
            ...current,
            state: sent ? "sent" : "unknown",
          });
      });
    } catch {
      /* The receipt stays "sending", as uncertain as "unknown". */
    }
  }
  verify(challengeId: string, code: string) {
    // Return denial from the transaction so failed attempts actually commit.
    const result = this.store.transaction(() => {
      const c = this.store.get<Challenge>(challenges, challengeId);
      if (
        !c ||
        c.state === "consumed" ||
        c.expiresAt <= this.now() ||
        c.attempts >= 5
      )
        return null;
      // A withheld challenge was never texted, so no code matches it.
      const valid =
        c.eligible !== false &&
        !!c.sealed &&
        /^\d{8}$/.test(code) &&
        equal(c.digest, this.digest(c.id, code));
      const consumed = valid || c.attempts >= 4;
      // A consumed code verifies nothing more, so its sealed number goes.
      const { sealed, ...rest } = c;
      this.store.put(challenges, {
        ...(consumed ? rest : c),
        attempts: c.attempts + 1,
        state: consumed ? "consumed" : c.state,
      });
      if (!valid || !sealed) return null;
      const recipient = this.keys.open(sealed);
      // This client proved it receives this number's texts.
      if (c.client)
        this.store.put(knownClients, {
          id: this.digest("known", c.client, c.number),
          verifiedAt: this.now(),
        });
      const secret = token();
      const session = this.store.put<Session>(sessions, {
        id: hash(secret),
        memberId: `member_${this.digest("member", recipient)}`,
        number: c.number,
        sealed,
        expiresAt: this.now() + 3_600_000,
      });
      return { token: secret, expiresAt: session.expiresAt };
    });
    if (!result) throw denied();
    return result;
  }
  private session(proof: unknown) {
    if (typeof proof !== "string" || proof.length > 200) throw denied();
    const session = this.store.get<Session>(sessions, hash(proof));
    if (!session || session.expiresAt <= this.now()) throw denied();
    return session;
  }
  async account(proof: unknown) {
    const s = this.session(proof);
    return { memberId: s.memberId, expiresAt: s.expiresAt };
  }
  /** The verified number, opened only in memory for enrollment, which keeps
   * its digest and a sealed copy for the member's callbacks. */
  async alias(proof: unknown) {
    const s = this.session(proof);
    const recipient = this.keys.open(s.sealed);
    return {
      memberId: s.memberId,
      lineId: this.options.lineId,
      recipient,
      conversationId: `iMessage;-;${recipient}`,
      expiresAt: s.expiresAt,
    };
  }
}
