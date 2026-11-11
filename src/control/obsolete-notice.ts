import type { Pairing } from "../contracts.js";
import type { Store } from "../storage/store.js";
import { DomainError, hash, type Vault } from "../storage/security.js";

type Notice = {
  id: string;
  state: string;
  sealed: string;
  pairing: Pairing;
  dispatch?: { operationOrigin: string };
};
type Invite = {
  id: string;
  binding: Record<string, unknown>;
  expiresAt: number;
  consumedAt?: number;
  pairingId?: string;
};
interface Retirement {
  version: 1;
  noticeId: string;
  noticeHash: string;
  inviteId: string;
  inviteHash: string;
  pairingId: string;
  pairingHash: string;
  operationOrigin: string;
  at: number;
  evidenceReference: string;
  reason: "consumed_expired_onboarding_notice";
  deliveryOutcome: "unknown";
  replayAllowed: false;
  cursorSnapshot: unknown;
}
const fields = [
  "memberId",
  "recipient",
  "lineId",
  "conversationId",
  "deviceId",
  "displayId",
] as const;
const digest = (value: unknown) => hash(JSON.stringify(value));
const key = (id: string) => `obsolete-notice-retirement:${id}`;
const spent = (i: Invite | undefined, now: number) =>
  !!i &&
  Number.isFinite(i.consumedAt) &&
  Number.isFinite(i.expiresAt) &&
  i.consumedAt! <= i.expiresAt &&
  i.expiresAt <= now;

/** A delivery fact remains unknown. Only an exact immutable supersession stops it blocking new work. */
export function noticeRetirementValid(
  store: Store,
  notice: { id: string; state: string },
  now = Date.now(),
): boolean {
  const record = store.event<Retirement>(key(notice.id));
  if (
    !record ||
    !record.result ||
    typeof record.result !== "object" ||
    record.fingerprint !== digest(record.result)
  )
    return false;
  const a = record.result,
    invite = store.get<Invite>("invite", a.inviteId),
    pairing = store.get<Pairing>("pairing", a.pairingId);
  return (
    a.version === 1 &&
    a.reason === "consumed_expired_onboarding_notice" &&
    a.deliveryOutcome === "unknown" &&
    a.replayAllowed === false &&
    a.noticeId === notice.id &&
    notice.state === "unknown" &&
    a.noticeHash === digest(notice) &&
    a.operationOrigin === `text_${hash(notice.id).slice(0, 32)}` &&
    spent(invite, now) &&
    a.inviteHash === digest(invite) &&
    !!pairing &&
    pairing.revokedAt === undefined &&
    pairing.allowView &&
    a.pairingHash === digest(pairing)
  );
}

/** Lead-only operator action. Never modifies notice, invite, pairing, cursor or provider state. */
export function retireObsoleteNotice(
  store: Store,
  vault: Vault,
  input: {
    noticeId: string;
    pairingId: string;
    evidenceReference: string;
    allowedOrigins: string[];
  },
  now = Date.now(),
) {
  const refuse = () => {
    throw new DomainError(
      409,
      "Obsolete notice proof is incomplete; preserve all outcomes and do not replay.",
    );
  };
  return store.transaction(() => {
    const notice = store.get<Notice>("notice", input.noticeId);
    if (!notice || notice.state !== "unknown") return refuse();
    const previous = store.event<Retirement>(key(notice.id));
    if (previous) {
      if (
        !noticeRetirementValid(store, notice, now) ||
        previous.result.pairingId !== input.pairingId ||
        previous.result.evidenceReference !== input.evidenceReference
      )
        return refuse();
      return previous.result;
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(input.evidenceReference)) return refuse();
    const text = vault.open<unknown>(notice.sealed);
    if (typeof text !== "string") return refuse();
    // This recovery deliberately recognizes only the original obsolete pilot template.
    const match =
      /^Install and pair your Mac: (https:\/\/\S+) \. This private link expires in 10 minutes\.$/.exec(
        text,
      );
    if (!match) return refuse();
    const url = new URL(match[1]!);
    if (
      !input.allowedOrigins.includes(url.origin) ||
      url.pathname !== "/pair" ||
      url.username ||
      url.password ||
      url.search
    )
      return refuse();
    const fragment = new URLSearchParams(url.hash.slice(1));
    if (
      [...fragment.keys()].length !== 3 ||
      ["token", "device", "display"].some(
        (k) => fragment.getAll(k).length !== 1,
      )
    )
      return refuse();
    const token = fragment.get("token");
    if (!token) return refuse();
    const invite = store.get<Invite>("invite", hash(token));
    const pairing = store.get<Pairing>("pairing", input.pairingId);
    if (
      !spent(invite, now) ||
      !invite ||
      !pairing ||
      pairing.revokedAt !== undefined ||
      !pairing.allowView ||
      fields.some(
        (f) =>
          invite.binding[f] !== pairing[f] || notice.pairing[f] !== pairing[f],
      ) ||
      fragment.get("device") !== pairing.deviceId ||
      fragment.get("display") !== pairing.displayId ||
      (invite.pairingId && invite.pairingId !== pairing.id) ||
      !Number.isFinite(pairing.createdAt) ||
      Math.abs(pairing.createdAt - invite.consumedAt!) > 1000 ||
      store
        .all<Pairing>("pairing")
        .filter((p) => fields.every((f) => p[f] === pairing[f])).length !== 1
    )
      return refuse();
    const inboundId = notice.id.endsWith(":notice")
      ? notice.id.slice(0, -7)
      : "";
    const inbound = store.get<{ id: string; state: string; sealed: string }>(
      "inbound",
      inboundId,
    );
    if (!inbound || inbound.state !== "done") return refuse();
    const event = vault.open<{
      id: string;
      text: string;
      sender: string;
      lineId: string;
      conversationId: string;
    }>(inbound.sealed);
    if (
      event.id !== inboundId ||
      event.text.trim().toLowerCase() !== "pair" ||
      event.sender !== pairing.recipient ||
      event.lineId !== pairing.lineId ||
      event.conversationId !== pairing.conversationId
    )
      return refuse();
    const operationOrigin = `text_${hash(notice.id).slice(0, 32)}`;
    if (notice.dispatch && notice.dispatch.operationOrigin !== operationOrigin)
      return refuse();
    // No retirement while another external/control operation may be in flight.
    if (
      store
        .all<{ state: string }>("inbound")
        .some((i) => ["pending", "running", "unknown"].includes(i.state)) ||
      store
        .all<{ id: string; state: string }>("notice")
        .some(
          (n) =>
            n.id !== notice.id &&
            (["pending", "running"].includes(n.state) ||
              (n.state === "unknown" && !noticeRetirementValid(store, n, now))),
        ) ||
      store
        .effects()
        .some((e) => ["pending", "running", "unknown"].includes(e.state)) ||
      store.all<{ state: string }>("call").some((c) => c.state !== "ended") ||
      store
        .all<{ state: string }>("lease")
        .some((l) => l.state !== "released") ||
      store
        .all<{ state: string }>("action")
        .some((a) =>
          ["pending", "running", "submitted", "unknown"].includes(a.state),
        )
    )
      return refuse();
    const cursorSnapshot = store.state(`messages:${pairing.lineId}`);
    if (!cursorSnapshot) return refuse();
    const audit: Retirement = {
      version: 1,
      noticeId: notice.id,
      noticeHash: digest(notice),
      inviteId: invite.id,
      inviteHash: digest(invite),
      pairingId: pairing.id,
      pairingHash: digest(pairing),
      operationOrigin,
      at: now,
      evidenceReference: input.evidenceReference,
      reason: "consumed_expired_onboarding_notice",
      deliveryOutcome: "unknown",
      replayAllowed: false,
      cursorSnapshot,
    };
    store.recordEvent(key(notice.id), digest(audit), audit); // insert-only; no upsert
    return audit;
  });
}
