import { createHmac, randomInt } from "node:crypto";
import { z } from "zod";
import { Store } from "../storage/store.js";
import { DomainError, equal, hash, token } from "../storage/security.js";

interface Challenge {
  id: string;
  recipient: string;
  digest: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  state: "sending" | "sent" | "unknown" | "consumed";
}
interface Session {
  id: string;
  memberId: string;
  recipient: string;
  expiresAt: number;
}
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/);
const denied = () => new DomainError(403, "identity_refused");

/** Passwordless phone possession proof. Only the requested recipient receives
 * the code. No inbound masked sender or caller metadata is treated as identity.
 * Delivery and verification have separate durable receipts and bounded rates. */
export class SharedPhoneIdentity {
  constructor(
    private store: Store,
    private options: {
      lineId: string;
      key: string;
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
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private digest(...values: string[]) {
    return createHmac("sha256", Buffer.from(this.options.key, "hex"))
      .update(JSON.stringify(values))
      .digest("hex");
  }
  async start(raw: string) {
    const recipient = phone.parse(raw);
    const code = randomInt(100_000_000).toString().padStart(8, "0");
    const challenge = this.store.transaction(() => {
      const recent = this.store
        .all<Challenge>("shared_identity_challenge")
        .filter((c) => c.createdAt > this.now() - 3_600_000);
      if (
        recent.length >= 100 ||
        recent.filter(
          (c) =>
            c.recipient === recipient && c.createdAt > this.now() - 600_000,
        ).length >= 3
      )
        throw new DomainError(429, "identity_rate_limited");
      const id = token();
      return this.store.put<Challenge>("shared_identity_challenge", {
        id,
        recipient,
        digest: this.digest(id, code),
        createdAt: this.now(),
        expiresAt: this.now() + 300_000,
        attempts: 0,
        state: "sending",
      });
    });
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
    this.store.put("shared_identity_challenge", {
      ...challenge,
      state: sent ? "sent" : "unknown",
    });
    return {
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt,
      delivery: sent ? "submitted" : "unknown",
    };
  }
  verify(challengeId: string, code: string) {
    // Return denial from the transaction so failed attempts actually commit.
    const result = this.store.transaction(() => {
      const c = this.store.get<Challenge>(
        "shared_identity_challenge",
        challengeId,
      );
      if (
        !c ||
        c.state === "consumed" ||
        c.expiresAt <= this.now() ||
        c.attempts >= 5
      )
        return null;
      const valid =
        /^\d{8}$/.test(code) && equal(c.digest, this.digest(c.id, code));
      this.store.put("shared_identity_challenge", {
        ...c,
        attempts: c.attempts + 1,
        state: valid || c.attempts >= 4 ? "consumed" : c.state,
      });
      if (!valid) return null;
      const secret = token();
      const session = this.store.put<Session>("shared_identity_session", {
        id: hash(secret),
        memberId: `member_${this.digest("member", c.recipient)}`,
        recipient: c.recipient,
        expiresAt: this.now() + 3_600_000,
      });
      return { token: secret, expiresAt: session.expiresAt };
    });
    if (!result) throw denied();
    return result;
  }
  private session(proof: unknown) {
    if (typeof proof !== "string" || proof.length > 200) throw denied();
    const session = this.store.get<Session>(
      "shared_identity_session",
      hash(proof),
    );
    if (!session || session.expiresAt <= this.now()) throw denied();
    return session;
  }
  async account(proof: unknown) {
    const s = this.session(proof);
    return { memberId: s.memberId, expiresAt: s.expiresAt };
  }
  async alias(proof: unknown) {
    const s = this.session(proof);
    return {
      memberId: s.memberId,
      lineId: this.options.lineId,
      recipient: s.recipient,
      conversationId: `iMessage;-;${s.recipient}`,
      expiresAt: s.expiresAt,
    };
  }
}
