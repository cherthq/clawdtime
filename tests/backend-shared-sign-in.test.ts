import { afterEach, describe, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";
import { createSharedNumberApp } from "../src/shared-number-app.js";
import {
  SharedPhoneIdentity,
  signInClient,
} from "../src/pairing/shared-phone-identity.js";
import { Store } from "../src/storage/store.js";

// Made-up numbers and documentation addresses only.
const member = "+14155550100";
const invited = "+12125550100";
const stranger = "+13125550100";
const attacker = "203.0.113.9";
const memberMac = "198.51.100.7";
const lineToken = "test-line-token-".repeat(4);

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function coordinator(
  store: Store,
  invitedNumbers: string[],
  behindProxy = true,
) {
  const texts: { recipient: string; code: string }[] = [];
  const service = createSharedNumberApp({
    store,
    lineId: "line",
    proofKey: "aa".repeat(32),
    identityKey: "bb".repeat(32),
    lineToken,
    invited: invitedNumbers,
    behindProxy,
    sendCode: async (recipient, code) => {
      texts.push({ recipient, code });
      return true;
    },
  });
  const server = serve({
    fetch: service.app.fetch,
    hostname: "127.0.0.1",
    port: 0,
  });
  await new Promise<void>((resolve) =>
    server.listening ? resolve() : server.once("listening", resolve),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw Error("address");
  const origin = `http://127.0.0.1:${address.port}`;
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        service.close();
        server.close(() => resolve());
        if ("closeAllConnections" in server) server.closeAllConnections();
      }),
  );
  // The loopback peer stands in for the HTTPS proxy of the setup guide,
  // which appends the client address to X-Forwarded-For.
  const post = async (
    path: string,
    data: unknown,
    options: { client?: string; type?: string; token?: string } = {},
  ) => {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        "content-type": options.type ?? "application/json",
        ...(options.client ? { "x-forwarded-for": options.client } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify(data),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: (await response.json().catch(() => null)) as any,
    };
  };
  const start = (recipient: string, client?: string) =>
    post("/auth/start", { recipient }, { client });
  const codeFor = (recipient: string) =>
    texts.filter((t) => t.recipient === recipient).at(-1)?.code;
  return { origin, post, start, texts, codeFor };
}

describe("shared sign-in texts", () => {
  it("texts only an invited number or a member, and answers anyone else the same way", async () => {
    const store = new Store();
    cleanup.push(() => store.close());
    const first = await coordinator(store, [member, invited]);
    const signedIn = await first.start(member, memberMac);
    const session = await first.post("/auth/verify", {
      challengeId: signedIn.body.challengeId,
      code: first.codeFor(member),
    });
    expect(session.status).toBe(200);
    // Enrollment makes the number a member.
    expect(
      (await first.post("/account/invite", {}, { token: session.body.token }))
        .status,
    ).toBe(200);

    // The operator later drops the member from the invitations.
    const f = await coordinator(store, [invited]);
    const toInvited = await f.start(invited, memberMac);
    const toMember = await f.start(member, memberMac);
    const toStranger = await f.start(stranger, memberMac);
    for (const answer of [toInvited, toMember, toStranger]) {
      expect(answer.status).toBe(200);
      expect(Object.keys(answer.body).sort()).toEqual([
        "challengeId",
        "expiresAt",
      ]);
    }
    expect(f.texts.map((t) => t.recipient).sort()).toEqual(
      [invited, member].sort(),
    );
    // A stranger's challenge refuses every code exactly like a wrong code.
    const wrong = await f.post("/auth/verify", {
      challengeId: toInvited.body.challengeId,
      code: "00000000",
    });
    for (const code of ["00000000", "12345678"]) {
      const refused = await f.post("/auth/verify", {
        challengeId: toStranger.body.challengeId,
        code,
      });
      expect(refused.status).toBe(wrong.status);
      expect(refused.body).toEqual(wrong.body);
    }
    // A stranger's number reaches its limit exactly when a member's does.
    for (let i = 0; i < 2; i++) {
      expect((await f.start(stranger, memberMac)).status).toBe(200);
      expect((await f.start(invited, memberMac)).status).toBe(200);
    }
    expect((await f.start(stranger, memberMac)).status).toBe(429);
    expect((await f.start(invited, memberMac)).status).toBe(429);
    expect(f.texts.some((t) => t.recipient === stranger)).toBe(false);
  });

  it("texts a member whose Mac was unpaired, but not a member who asked for a ban", async () => {
    const store = new Store();
    cleanup.push(() => store.close());
    const first = await coordinator(store, [member]);
    const signedIn = await first.start(member, memberMac);
    const { token } = (
      await first.post("/auth/verify", {
        challengeId: signedIn.body.challengeId,
        code: first.codeFor(member),
      })
    ).body;
    const invitation = await first.post("/account/invite", {}, { token });
    const paired = await first.post("/pair/accept", {
      invitation: invitation.body.invitation,
      acceptance: {
        localAccepted: true,
        displayId: "display",
        allowView: true,
        allowControl: false,
      },
    });
    // Revoke unpairs the Mac. The member stays enrolled and can pair again.
    expect((await first.post("/account/revoke", {}, { token })).status).toBe(
      200,
    );
    const again = await coordinator(store, []);
    expect((await again.start(member, memberMac)).status).toBe(200);
    expect(again.texts).toHaveLength(1);
    const repaired = await first.post("/pair/accept", {
      invitation: (await first.post("/account/invite", {}, { token })).body
        .invitation,
      acceptance: {
        localAccepted: true,
        displayId: "display",
        allowView: true,
        allowControl: false,
      },
    });
    expect(paired.status).toBe(200);
    // A ban needs the sign-in and the paired Mac's credential together.
    expect(
      (
        await first.post(
          "/account/revoke",
          {
            permanent: true,
            deviceCredential: repaired.body.credential,
          },
          { token },
        )
      ).status,
    ).toBe(200);
    const f = await coordinator(store, []);
    expect((await f.start(member, memberMac)).status).toBe(200);
    expect(f.texts).toEqual([]);
  });

  it("limits one client and one number from one client, so a member still signs in during an attack", async () => {
    const store = new Store();
    cleanup.push(() => store.close());
    const others = Array.from(
      { length: 12 },
      (_, i) => `+1415555${String(1000 + i)}`,
    );
    const f = await coordinator(store, [member, invited, ...others]);
    for (let i = 0; i < 3; i++)
      expect((await f.start(member, attacker)).status).toBe(200);
    expect((await f.start(member, attacker)).status).toBe(429);
    for (const number of others.slice(0, 7))
      expect((await f.start(number, attacker)).status).toBe(200);
    // Ten starts in one hour from one client: every further start is refused.
    expect((await f.start(others[7]!, attacker)).status).toBe(429);
    expect((await f.start(stranger, attacker)).status).toBe(429);

    const own = await f.start(member, memberMac);
    expect(own.status).toBe(200);
    const verified = await f.post("/auth/verify", {
      challengeId: own.body.challengeId,
      code: f.codeFor(member),
    });
    expect(verified.status).toBe(200);
    expect(typeof verified.body.token).toBe("string");
  });

  it("ignores a forwarded address unless the coordinator is behind a proxy", async () => {
    const store = new Store();
    cleanup.push(() => store.close());
    const others = Array.from(
      { length: 11 },
      (_, i) => `+1312555${String(2000 + i)}`,
    );
    const f = await coordinator(store, [], false);
    // Every start comes from the loopback socket, whatever the header says.
    for (const [i, number] of others.slice(0, 10).entries())
      expect((await f.start(number, `203.0.113.${i + 1}`)).status).toBe(200);
    expect((await f.start(others[10]!, memberMac)).status).toBe(429);
  });

  it("refuses simple-request content types and grants no cross-origin access", async () => {
    const store = new Store();
    cleanup.push(() => store.close());
    const f = await coordinator(store, [member]);
    for (const type of [
      "text/plain",
      "text/plain;charset=UTF-8",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "application/jsonx",
    ]) {
      const refused = await f.post(
        "/auth/start",
        { recipient: member },
        { type, client: memberMac },
      );
      expect(refused.status, type).toBe(415);
      const verify = await f.post(
        "/auth/verify",
        { challengeId: "challenge", code: "00000000" },
        { type },
      );
      expect(verify.status, type).toBe(415);
    }
    expect(f.texts).toEqual([]);
    const accepted = await f.post(
      "/auth/start",
      { recipient: member },
      { type: "application/json; charset=utf-8", client: memberMac },
    );
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("access-control-allow-origin")).toBeNull();
    const preflight = await fetch(`${f.origin}/auth/start`, {
      method: "OPTIONS",
      headers: {
        origin: "https://page.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(preflight.headers.get("access-control-allow-methods")).toBeNull();
  });
});

describe("shared sign-in limits and storage", () => {
  const numbers = (prefix: string, count: number) =>
    Array.from(
      { length: count },
      (_, i) => `${prefix}${String(i).padStart(4, "0")}`,
    );
  it("keeps a ceiling of texts for the line that strangers' starts do not use up", async () => {
    const store = new Store();
    cleanup.push(() => store.close());
    const members = numbers("+1415555", 101);
    const sent: string[] = [];
    const identity = new SharedPhoneIdentity(store, {
      lineId: "line",
      key: "bb".repeat(32),
      invited: members,
      send: async (recipient) => {
        sent.push(recipient);
        return true;
      },
    });
    const strangers = numbers("+1312555", 100);
    for (const [i, number] of strangers.entries())
      await identity.start(number, `stranger-${Math.floor(i / 10)}`);
    expect(sent).toEqual([]);
    for (const [i, number] of members.slice(0, 100).entries())
      await identity.start(number, `client-${Math.floor(i / 10)}`);
    expect(sent).toHaveLength(100);
    await expect(identity.start(members[100]!, "fresh")).rejects.toThrow(
      "identity_rate_limited",
    );
    // Over the ceiling, a stranger gets the same refusal as a member.
    await expect(identity.start(strangers[0]!, "fresh")).rejects.toThrow(
      "identity_rate_limited",
    );
  });

  it("prunes expired challenges and does not read every challenge to start", async () => {
    const store = new Store();
    cleanup.push(() => store.close());
    let now = 1_000_000;
    const identity = new SharedPhoneIdentity(store, {
      lineId: "line",
      key: "bb".repeat(32),
      invited: [member],
      now: () => now,
      send: async () => true,
    });
    const old = await identity.start(member, memberMac);
    const stale = await identity.start(stranger, memberMac);
    now += 61 * 60_000;
    const all = vi.spyOn(store, "all");
    const fresh = await identity.start(member, memberMac);
    expect(
      all.mock.calls.some(([kind]) => kind === "shared_identity_challenge"),
    ).toBe(false);
    expect(store.get("shared_identity_challenge", old.challengeId)).toBe(
      undefined,
    );
    expect(store.get("shared_identity_challenge", stale.challengeId)).toBe(
      undefined,
    );
    expect(store.get("shared_identity_challenge", fresh.challengeId)).toEqual(
      expect.objectContaining({ recipient: member }),
    );
  });

  it("does not undo a consumed challenge when the text receipt arrives late", async () => {
    const store = new Store();
    cleanup.push(() => store.close());
    let finish!: (sent: boolean) => void;
    let code = "";
    const identity = new SharedPhoneIdentity(store, {
      lineId: "line",
      key: "bb".repeat(32),
      invited: [member],
      send: (_recipient, sentCode) => {
        code = sentCode;
        return new Promise<boolean>((resolve) => (finish = resolve));
      },
    });
    const challenge = await identity.start(member, memberMac);
    identity.verify(challenge.challengeId, code);
    finish(true);
    await vi.waitFor(() =>
      expect(
        store.get<{ state: string }>(
          "shared_identity_challenge",
          challenge.challengeId,
        )?.state,
      ).toBe("consumed"),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(() => identity.verify(challenge.challengeId, code)).toThrow(
      "identity_refused",
    );
  });
});

describe("sign-in client address", () => {
  it("trusts the forwarded address only from a local or private proxy", () => {
    expect(signInClient("203.0.113.9", "198.51.100.1")).toBe("203.0.113.9");
    expect(signInClient("127.0.0.1", "198.51.100.1, 203.0.113.7")).toBe(
      "203.0.113.7",
    );
    expect(signInClient("::ffff:127.0.0.1", "203.0.113.7")).toBe("203.0.113.7");
    expect(signInClient("::1", "203.0.113.7")).toBe("203.0.113.7");
    expect(signInClient("10.0.0.5", "203.0.113.7")).toBe("203.0.113.7");
    expect(signInClient("10.0.0.5", undefined)).toBe("10.0.0.5");
    expect(signInClient("127.0.0.1", "not-an-address")).toBe("127.0.0.1");
    expect(signInClient(undefined, "203.0.113.7")).toBe("unknown");
  });
  it("groups an IPv6 client by its /64", () => {
    expect(signInClient("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(signInClient("2001:db8:1:2::9")).toBe("2001:db8:1:2::/64");
    expect(signInClient("::1", "2001:db8:a::1")).toBe("2001:db8:a:0::/64");
  });
});
