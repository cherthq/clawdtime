import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SharedNumber,
  UNVERIFIED_LIMIT_MS,
} from "../src/control/shared-number.js";
import { Store } from "../src/storage/store.js";
import { hash } from "../src/storage/security.js";
import type {
  CallProofTurn,
  RoutingProviderEvent,
  SharedNumberVerifiers,
} from "../src/shared-number-contracts.js";

const stores: Store[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(path?: string) {
  let now = 1_000_000;
  const store = new Store(path);
  stores.push(store);
  // These mocks model trusted adapters. They do not qualify a provider or IDP.
  const verifiers: SharedNumberVerifiers = {
    async account(proof) {
      if (proof !== "account-a" && proof !== "account-b")
        throw new Error("invalid account proof");
      return { memberId: proof, expiresAt: now + 60_000 };
    },
    async alias(proof) {
      if (proof !== "alias-a" && proof !== "alias-b")
        throw new Error("unverified alias");
      const a = proof === "alias-a";
      // Same last four digits intentionally. Only exact verified aliases count.
      const recipient = a ? "+14155550100" : "+12125550100";
      return {
        memberId: a ? "account-a" : "account-b",
        lineId: "line",
        recipient,
        conversationId: `iMessage;-;${recipient}`,
        expiresAt: now + 60_000,
      };
    },
    async callProofTurn(proof) {
      if (!proof || typeof proof !== "object" || !("qualifiedFixture" in proof))
        throw new Error("unqualified call turn");
      return (proof as { qualifiedFixture: CallProofTurn }).qualifiedFixture;
    },
    async provider(proof) {
      if (!proof || typeof proof !== "object" || !("verifiedFixture" in proof))
        throw new Error("unverified provider event");
      return (proof as { verifiedFixture: RoutingProviderEvent })
        .verifiedFixture;
    },
  };
  const options = {
    lineId: "line",
    proofKey: "ab".repeat(32),
    verifiers,
    now: () => now,
  };
  let router = new SharedNumber(store, options);
  const numbers = { a: "+14155550100", b: "+12125550100" };
  // The provider's observed caller handle. It selects whose Mac may be shown
  // a code; it never authorizes a Mac by itself.
  const event = (
    call = "call-a",
    kind: "incoming" | "cleanup_complete" = "incoming",
    caller: string | null = numbers.a,
  ) => ({
    verifiedFixture: {
      kind,
      eventId: `${call}:${kind}`,
      lineId: "line",
      providerCallId: call,
      roomId: `room:${call}`,
      participantId: `bridge:${call}`,
      expiresAt: now + 60_000,
      ...(kind === "incoming" && caller ? { caller } : {}),
    },
  });
  let turn = 0;
  const proofTurn = (
    call: { providerCallId: string; roomId: string; participantId: string },
    code: string,
  ) => ({
    qualifiedFixture: {
      lineId: "line",
      providerCallId: call.providerCallId,
      roomId: call.roomId,
      participantId: call.participantId,
      code,
      turnId: `turn-${++turn}`,
      expiresAt: now + 10_000,
    },
  });
  const prove = (
    call: { providerCallId: string; roomId: string; participantId: string },
    code: string,
  ) => router.proveCall(proofTurn(call, code));
  const incoming = (call = "call-a", caller: string | null = numbers.a) =>
    router.providerEvent(event(call, "incoming", caller));
  const cleanup = (call = "call-a") =>
    router.providerEvent(event(call, "cleanup_complete"));
  const pair = async (member = "a", allowControl = true) => {
    await router.enroll(`account-${member}`, `alias-${member}`);
    const invite = await router.invite(`account-${member}`);
    return router.acceptInvitation(invite.invitation, {
      localAccepted: true,
      displayId: `display-${member}`,
      allowView: true,
      allowControl,
    });
  };
  const admitted = async (
    member = "a",
    providerCall = "call-a",
    allowControl = true,
  ) => {
    const device = await pair(member, allowControl);
    const connection = router.connect(device.credential, `instance-${member}`);
    const call = await incoming(
      providerCall,
      (numbers as Record<string, string>)[member] ?? null,
    );
    const proof = router.issueCallProof(device.credential, call.id);
    const result = await prove(call, proof.code);
    if (result.state !== "admitted") throw new Error("fixture not admitted");
    return { ...device, connection, call: result.call, proof };
  };
  return {
    get router() {
      return router;
    },
    store,
    options,
    verifiers,
    advance: (ms: number) => {
      now += ms;
    },
    event,
    incoming,
    cleanup,
    pair,
    admitted,
    prove,
    proofTurn,
    restart: () => {
      router = new SharedNumber(store, options);
    },
  };
}

describe("staged shared-number identity and ownership", () => {
  it("requires independent account, alias and provider verification", async () => {
    const f = fixture();
    await expect(
      f.router.enroll({ callerHash: "account-a" }, "alias-a"),
    ).rejects.toThrow();
    await expect(
      f.router.enroll("account-a", { masked_recipient: "0100" }),
    ).rejects.toThrow();
    await expect(f.router.enroll("account-a", "alias-b")).rejects.toThrow();
    await expect(
      f.router.providerEvent({ from: "+14155550100" }),
    ).rejects.toThrow();
    const call = await f.incoming();
    expect(call).toMatchObject({ state: "unknown_identity" });
    expect(call.scope).toBeUndefined();
    expect(() => f.router.authorizeCall(call.id, "invented", "view")).toThrow();
  });

  it("makes invitations short-lived, single-use and locally accepted", async () => {
    const f = fixture();
    await f.router.enroll("account-a", "alias-a");
    const invitation = await f.router.invite("account-a");
    const accepted = {
      localAccepted: true,
      displayId: "display-a",
      allowView: true,
      allowControl: false,
    };
    expect(() =>
      f.router.acceptInvitation(invitation.invitation, {
        ...accepted,
        localAccepted: false,
      }),
    ).toThrow();
    const result = f.router.acceptInvitation(invitation.invitation, accepted);
    expect(result.pairing.memberId).toBe("account-a");
    expect(() =>
      f.router.acceptInvitation(invitation.invitation, accepted),
    ).toThrow();
    await expect(f.router.invite("account-a")).rejects.toThrow();
    await f.router.enroll("account-b", "alias-b");
    const expired = await f.router.invite("account-b");
    f.advance(300_000);
    expect(() =>
      f.router.acceptInvitation(expired.invitation, accepted),
    ).toThrow();
  });

  it("issues a call code only to the paired Mac over its live connection, never to a sign-in", async () => {
    const f = fixture();
    const a = await f.pair();
    const call = await f.incoming();
    // A sign-in session alone, such as one phished text code, gets no call code.
    expect(() => f.router.issueCallProof("account-a", call.id)).toThrow();
    // The paired Mac must be connected before it is shown a code.
    expect(() => f.router.issueCallProof(a.credential, call.id)).toThrow();
    const first = f.router.connect(a.credential, "instance-a");
    const proof = f.router.issueCallProof(a.credential, call.id);
    expect(proof.code).toMatch(/^\d{8}$/);
    // The code admits the call only to the connection that was shown it.
    f.router.connect(a.credential, "instance-a");
    expect(await f.prove(call, proof.code)).toEqual({ state: "unauthorized" });
    expect(f.store.get<any>("shared_number_proof", call.id)).toMatchObject({
      credentialId: first.credentialId,
      connectionId: first.id,
    });
    await f.cleanup();
    const next = await f.incoming("call-next");
    f.router.connect(a.credential, "instance-a");
    const nextProof = f.router.issueCallProof(a.credential, next.id);
    const rotated = f.router.rotateCredential(a.credential);
    f.router.connect(rotated, "instance-a");
    expect(await f.prove(next, nextProof.code)).toEqual({
      state: "unauthorized",
    });
  });

  it("gives the call code only to the member whose verified number is calling", async () => {
    const f = fixture();
    const a = await f.pair(),
      b = await f.pair("b");
    f.router.connect(a.credential, "instance-a");
    f.router.connect(b.credential, "instance-b");
    const call = await f.incoming("call-a", "+14155550100");
    // Another member can neither take nor block this member's waiting call.
    expect(() => f.router.issueCallProof(b.credential, call.id)).toThrow(
      "shared_call_not_waiting",
    );
    expect(() => f.router.issueCallProof(b.credential)).toThrow(
      "shared_call_not_waiting",
    );
    const proof = f.router.issueCallProof(a.credential);
    const result = await f.prove(call, proof.code);
    expect(result.state).toBe("admitted");
    expect(result.state === "admitted" && result.call.scope?.deviceId).toBe(
      a.pairing.deviceId,
    );
    await f.cleanup("call-a");
    // A hidden or unknown caller handle gives no code to any member.
    await f.incoming("call-hidden", null);
    expect(() => f.router.issueCallProof(a.credential)).toThrow(
      "shared_call_not_waiting",
    );
    await f.cleanup("call-hidden");
    await f.incoming("call-other", "+13125550100");
    expect(() => f.router.issueCallProof(a.credential)).toThrow(
      "shared_call_not_waiting",
    );
    // A stranger's handle is kept only as a keyed digest.
    expect(JSON.stringify(f.store.all("shared_number_call"))).not.toContain(
      "+13125550100",
    );
  });

  it("releases a caller who never verifies, and frees the slot after the observed cleanup", async () => {
    const f = fixture();
    const a = await f.pair();
    f.router.connect(a.credential, "instance-a");
    expect(UNVERIFIED_LIMIT_MS).toBeGreaterThanOrEqual(60_000);
    expect(UNVERIFIED_LIMIT_MS).toBeLessThanOrEqual(120_000);
    const stranger = await f.incoming("call-stranger", "+13125550100");
    expect(f.router.releaseUnverified()).toEqual([]);
    f.advance(UNVERIFIED_LIMIT_MS);
    // The trusted line adapter ends this call. No code can admit it now.
    expect(f.router.releaseUnverified()).toEqual([
      {
        callId: stranger.id,
        providerCallId: "call-stranger",
        roomId: "room:call-stranger",
      },
    ]);
    expect(f.store.get<any>("shared_number_call", stranger.id)?.state).toBe(
      "unauthorized",
    );
    // The provider call may still be live: the slot waits for its cleanup.
    expect((await f.incoming("call-busy")).state).toBe("busy");
    await f.cleanup("call-stranger");
    expect(f.router.releaseUnverified()).toEqual([]);
    // A code shown late in the window expires with the window.
    const own = await f.incoming("call-own");
    f.advance(UNVERIFIED_LIMIT_MS - 10_000);
    f.router.connect(a.credential, "instance-a");
    const late = f.router.issueCallProof(a.credential);
    expect(late.expiresAt).toBe(own.createdAt + UNVERIFIED_LIMIT_MS);
    f.advance(10_000);
    expect(await f.prove(own, late.code)).toEqual({ state: "unauthorized" });
    expect(f.router.releaseUnverified()).toHaveLength(1);
  });

  it("releases a verified caller's offline or failed call so the line can end it", async () => {
    const f = fixture();
    const a = await f.pair();
    f.router.connect(a.credential, "instance-a");
    const call = await f.incoming();
    f.router.issueCallProof(a.credential);
    for (let i = 0; i < 5; i++) await f.prove(call, "00000000");
    expect(f.router.releaseUnverified()).toEqual([
      expect.objectContaining({ callId: call.id }),
    ]);
  });

  it("binds the proof to exact call, room and participant and consumes it once", async () => {
    const f = fixture();
    const a = await f.pair();
    f.router.connect(a.credential, "instance-a");
    const call = await f.incoming();
    const proof = f.router.issueCallProof(a.credential, call.id);
    for (const field of ["providerCallId", "roomId", "participantId"])
      await expect(
        f.prove({ ...call, [field]: "other" }, proof.code),
      ).rejects.toThrow();
    const result = await f.prove(call, proof.code);
    expect(result.state).toBe("admitted");
    await expect(f.prove(call, proof.code)).rejects.toThrow();
    expect(() => f.router.issueCallProof(a.credential, call.id)).toThrow();
    const persisted = JSON.stringify(f.store.all("shared_number_proof"));
    expect(persisted).not.toContain(proof.code);
    expect(persisted).toContain("consumedAt");
  });

  it("commits attempt limits even on denial and forbids code reset", async () => {
    const f = fixture();
    const a = await f.pair(),
      b = await f.pair("b");
    f.router.connect(a.credential, "instance-a");
    f.router.connect(b.credential, "instance-b");
    const call = await f.incoming();
    const proof = f.router.issueCallProof(a.credential, call.id);
    for (let i = 0; i < 5; i++)
      expect(await f.prove(call, "not-a-code")).toEqual({
        state: "unauthorized",
      });
    expect(f.store.get("shared_number_proof", call.id)?.attempts).toBe(5);
    await expect(f.prove(call, proof.code)).rejects.toThrow();
    expect(() => f.router.issueCallProof(b.credential, call.id)).toThrow();
  });

  it("requires a qualified original proof turn and deduplicates failed deliveries", async () => {
    const f = fixture();
    const a = await f.pair();
    f.router.connect(a.credential, "instance-a");
    const call = await f.incoming();
    const proof = f.router.issueCallProof(a.credential, call.id);
    await expect(
      f.router.proveCall({ ...call, code: proof.code }),
    ).rejects.toThrow();
    const wrong = f.proofTurn(call, "wrong");
    expect(await f.router.proveCall(wrong)).toEqual({ state: "unauthorized" });
    expect(await f.router.proveCall(wrong)).toEqual({ state: "unauthorized" });
    expect(f.store.get("shared_number_proof", call.id)?.attempts).toBe(1);
    f.restart();
    expect(await f.router.proveCall(wrong)).toEqual({ state: "unauthorized" });
    expect(f.store.get("shared_number_proof", call.id)?.attempts).toBe(1);
    await expect(
      f.router.proveCall({
        qualifiedFixture: {
          ...wrong.qualifiedFixture,
          code: proof.code,
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects expired proof without releasing the live line slot", async () => {
    const f = fixture();
    const a = await f.pair();
    f.router.connect(a.credential, "instance-a");
    const call = await f.incoming();
    const proof = f.router.issueCallProof(a.credential, call.id);
    f.advance(120_000);
    expect(await f.prove(call, proof.code)).toEqual({ state: "unauthorized" });
    expect((await f.incoming("call-b")).state).toBe("busy");
    await f.cleanup();
    expect((await f.incoming("call-c")).state).toBe("unknown_identity");
  });

  it("never routes an offline member to the other connected Mac", async () => {
    const f = fixture();
    const a = await f.pair(),
      b = await f.pair("b");
    f.router.connect(b.credential, "instance-b");
    const call = await f.incoming();
    f.router.connect(a.credential, "instance-a");
    const proof = f.router.issueCallProof(a.credential, call.id);
    f.advance(30_000);
    f.router.connect(b.credential, "instance-b");
    expect(await f.prove(call, proof.code)).toEqual({ state: "offline" });
    f.router.connect(a.credential, "instance-a");
    await expect(f.prove(call, proof.code)).rejects.toThrow();
  });

  it("isolates device credentials and fences old connections on rotation", async () => {
    const f = fixture();
    const a = await f.admitted(),
      b = await f.pair("b");
    const bc = f.router.connect(b.credential, "instance-b");
    expect(bc.deviceId).toBe(b.pairing.deviceId);
    expect(() => f.router.heartbeat(b.credential, a.connection.id)).toThrow();
    expect(() => f.router.disconnect(b.credential, a.connection.id)).toThrow();
    expect(() =>
      f.router.connect(a.credential.split(".")[0] + ".forged", "instance-a"),
    ).toThrow();
    const rotated = f.router.rotateCredential(a.credential);
    expect(() => f.router.connect(a.credential, "instance-a")).toThrow();
    f.router.connect(rotated, "instance-a");
    expect(() =>
      f.router.authorizeCall(a.call.id, a.call.scope!.grantId, "view"),
    ).toThrow();
    expect(
      JSON.stringify(f.store.all("shared_number_credential")),
    ).not.toContain(rotated.split(".")[1]);
  });

  it("re-pairs a lost Mac through the signed-in account and fences the old Mac", async () => {
    const f = fixture();
    const a = await f.admitted();
    // There is no implicit replacement of the paired Mac.
    await expect(f.router.invite("account-a")).rejects.toThrow();
    const stale = await f.router.invite("account-a", { replace: true });
    const invite = await f.router.invite("account-a", { replace: true });
    const acceptance = {
      localAccepted: true,
      displayId: "display-new",
      allowView: true,
      allowControl: true,
    };
    const replaced = f.router.acceptInvitation(invite.invitation, acceptance);
    expect(replaced.pairing.deviceId).not.toBe(a.pairing.deviceId);
    expect(() => f.router.connect(a.credential, "instance-a")).toThrow();
    expect(() =>
      f.router.authorizeCall(a.call.id, a.call.scope!.grantId, "view"),
    ).toThrow();
    // An invitation from before that replacement cannot replace it again.
    expect(() =>
      f.router.acceptInvitation(stale.invitation, acceptance),
    ).toThrow();
    await f.cleanup();
    f.router.connect(replaced.credential, "instance-new");
    const call = await f.incoming("call-new");
    const proof = f.router.issueCallProof(replaced.credential);
    const result = await f.prove(call, proof.code);
    expect(result.state === "admitted" && result.call.scope?.deviceId).toBe(
      replaced.pairing.deviceId,
    );
  });

  it("revokes a pairing without banning the number; a ban needs the paired Mac too", async () => {
    const f = fixture();
    const a = await f.pair(),
      b = await f.pair("b");
    await f.router.revoke("account-a");
    expect(() => f.router.connect(a.credential, "instance-a")).toThrow();
    // One sign-in alone cannot ban the number: the member pairs again.
    await f.router.enroll("account-a", "alias-a");
    const again = f.router.acceptInvitation(
      (await f.router.invite("account-a")).invitation,
      {
        localAccepted: true,
        displayId: "display-a",
        allowView: true,
        allowControl: false,
      },
    );
    await expect(
      f.router.revoke("account-a", { permanent: true }),
    ).rejects.toThrow();
    await expect(
      f.router.revoke("account-a", {
        permanent: true,
        deviceCredential: b.credential,
      }),
    ).rejects.toThrow();
    f.router.connect(again.credential, "instance-a");
    await f.router.revoke("account-a", {
      permanent: true,
      deviceCredential: again.credential,
    });
    await expect(f.router.enroll("account-a", "alias-a")).rejects.toThrow();
    await expect(f.router.invite("account-a")).rejects.toThrow();
    expect(() => f.router.connect(again.credential, "instance-a")).toThrow();
    f.router.connect(b.credential, "instance-b");
  });

  it("keeps view and control separate and rechecks revocation", async () => {
    const f = fixture();
    const a = await f.admitted("a", "call-a", false);
    expect(
      f.router.authorizeCall(a.call.id, a.call.scope!.grantId, "view").id,
    ).toBe(a.call.id);
    expect(() =>
      f.router.authorizeCall(a.call.id, a.call.scope!.grantId, "control"),
    ).toThrow();
    await f.router.revoke("account-a");
    expect(() =>
      f.router.authorizeCall(a.call.id, a.call.scope!.grantId, "view"),
    ).toThrow();
    expect(() => f.router.connect(a.credential, "instance-a")).toThrow();
  });

  it("fences expired heartbeats and a replacement instance without rebinding", async () => {
    const f = fixture();
    const a = await f.admitted();
    f.advance(30_000);
    expect(() =>
      f.router.authorizeCall(a.call.id, a.call.scope!.grantId, "control"),
    ).toThrow();
    expect(() => f.router.heartbeat(a.credential, a.connection.id)).toThrow();
    f.router.connect(a.credential, "instance-new");
    expect(() =>
      f.router.authorizeCall(a.call.id, a.call.scope!.grantId, "view"),
    ).toThrow();
    expect((await f.incoming("call-b")).state).toBe("busy");
  });

  it("deduplicates verified events and refuses conflicting or forged cleanup", async () => {
    const f = fixture();
    const event = f.event();
    const call = await f.router.providerEvent(event);
    expect((await f.router.providerEvent(event)).id).toBe(call.id);
    await expect(
      f.router.providerEvent({
        verifiedFixture: { ...event.verifiedFixture, roomId: "other" },
      }),
    ).rejects.toThrow();
    await expect(
      f.router.providerEvent({ kind: "cleanup_complete", ...call }),
    ).rejects.toThrow();
    expect((await f.incoming("call-b")).state).toBe("busy");
    await f.cleanup("call-b"); // A rejected caller's cleanup cannot free the owner.
    expect((await f.incoming("call-c")).state).toBe("busy");
    await f.cleanup();
    expect((await f.router.providerEvent(event)).state).toBe("ended");
  });

  it("retains early cleanup across recovery without reserving or releasing another call's slot", async () => {
    const f = fixture();
    const ended = await f.cleanup("call-ended");
    expect(ended.state).toBe("ended");
    expect(ended.scope).toBeUndefined();
    f.restart();
    expect(await f.incoming("call-ended")).toEqual(ended);
    expect((await f.incoming("call-live")).state).toBe("unknown_identity");
    await f.cleanup("call-other-ended");
    expect((await f.incoming("call-other-ended")).state).toBe("ended");
    expect((await f.incoming("call-busy")).state).toBe("busy");
    const conflicting = f.event("call-ended");
    conflicting.verifiedFixture.eventId = "changed-binding";
    conflicting.verifiedFixture.roomId = "other-room";
    await expect(f.router.providerEvent(conflicting)).rejects.toThrow();
    await f.cleanup("call-live");
    expect((await f.incoming("call-next")).state).toBe("unknown_identity");
  });

  it("deduplicates reverified provider events without accepting expired or changed evidence", async () => {
    const f = fixture();
    const original = f.event();
    const call = await f.router.providerEvent(original);
    f.advance(60_000);
    await expect(f.router.providerEvent(original)).rejects.toThrow();
    expect(await f.incoming()).toEqual(call);
    const changed = f.event();
    changed.verifiedFixture.participantId = "other-participant";
    await expect(f.router.providerEvent(changed)).rejects.toThrow();
    const ended = await f.cleanup();
    f.advance(1_000);
    expect(await f.cleanup()).toEqual(ended);
    expect(await f.incoming()).toEqual(ended);
    expect((await f.incoming("call-next")).state).toBe("unknown_identity");
  });

  it("deduplicates a reverified proof turn across recovery without resetting its attempts", async () => {
    const f = fixture();
    const device = await f.pair();
    f.router.connect(device.credential, "instance-a");
    const call = await f.incoming();
    const proof = f.router.issueCallProof(device.credential, call.id);
    const wrong = f.proofTurn(call, "wrong");
    expect(await f.router.proveCall(wrong)).toEqual({ state: "unauthorized" });
    f.advance(10_000);
    await expect(f.router.proveCall(wrong)).rejects.toThrow();
    const refreshed = {
      qualifiedFixture: {
        ...wrong.qualifiedFixture,
        expiresAt: wrong.qualifiedFixture.expiresAt + 10_000,
      },
    };
    f.restart();
    expect(await f.router.proveCall(refreshed)).toEqual({
      state: "unauthorized",
    });
    expect(f.store.get("shared_number_proof", call.id)?.attempts).toBe(1);
    await expect(
      f.router.proveCall({
        qualifiedFixture: { ...refreshed.qualifiedFixture, code: proof.code },
      }),
    ).rejects.toThrow();
    // The restart ended the connection that was shown the code. A new
    // connection of the same Mac cannot use that code.
    f.router.connect(device.credential, "instance-a");
    const valid = f.proofTurn(call, proof.code);
    expect(await f.router.proveCall(valid)).toEqual({ state: "unauthorized" });
    f.advance(1_000);
    await expect(
      f.router.proveCall({
        qualifiedFixture: {
          ...valid.qualifiedFixture,
          expiresAt: valid.qualifiedFixture.expiresAt + 1_000,
        },
      }),
    ).rejects.toThrow();
  });

  it("records task ownership before execution and preserves it across intervening calls", async () => {
    const f = fixture();
    const a = await f.admitted();
    const input = {
      taskId: "task-a",
      userTurnId: "turn-a",
      requestDigest: hash("Make a sample note"),
    };
    const task = f.router.createTask(a.call.id, a.call.scope!.grantId, input);
    expect(
      f.router.createTask(a.call.id, a.call.scope!.grantId, input),
    ).toEqual(task);
    expect(() =>
      f.router.createTask(a.call.id, a.call.scope!.grantId, {
        ...input,
        taskId: "duplicate",
      }),
    ).toThrow();
    expect(() =>
      f.router.createTask(a.call.id, a.call.scope!.grantId, {
        ...input,
        requestDigest: hash("changed"),
      }),
    ).toThrow();
    await f.cleanup();
    const b = await f.admitted("b", "call-b");
    f.router.createTask(b.call.id, b.call.scope!.grantId, {
      ...input,
      taskId: "task-b",
    });
    expect(() =>
      f.router.completeTask(b.credential, b.connection.id, task.id, "result-a"),
    ).toThrow();
    const cb = f.router.completeTask(
      b.credential,
      b.connection.id,
      "task-b",
      "result-b",
    );
    const ca = f.router.completeTask(
      a.credential,
      a.connection.id,
      task.id,
      "result-a",
    );
    expect(ca.scope.deviceId).toBe(a.pairing.deviceId);
    expect(ca.scope.recipient).toBe("+14155550100");
    expect(cb.scope.recipient).toBe("+12125550100");
    expect(ca.callId).toBe(a.call.id);
    expect(
      f.router.completeTask(a.credential, a.connection.id, task.id, "result-a"),
    ).toEqual(ca);
    expect(() =>
      f.router.completeTask(
        a.credential,
        a.connection.id,
        task.id,
        "changed-result",
      ),
    ).toThrow();
  });

  it("retains durable ownership and blocks old calls after coordinator recovery", async () => {
    const directory = mkdtempSync(join(tmpdir(), "shared-number-"));
    directories.push(directory);
    const path = join(directory, "routing.sqlite");
    const f = fixture(path),
      a = await f.admitted();
    f.router.createTask(a.call.id, a.call.scope!.grantId, {
      taskId: "task-a",
      userTurnId: "turn-a",
      requestDigest: hash("Make a sample note"),
    });
    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const reopened = new Store(path);
    stores.push(reopened);
    const recovered = new SharedNumber(reopened, f.options);
    expect(reopened.get("shared_number_call", a.call.id)?.state).toBe(
      "outcome_unknown",
    );
    expect(() =>
      recovered.authorizeCall(a.call.id, a.call.scope!.grantId, "view"),
    ).toThrow();
    expect((await recovered.providerEvent(f.event("call-b"))).state).toBe(
      "busy",
    );
    const connection = recovered.connect(a.credential, "instance-a");
    const result = recovered.completeTask(
      a.credential,
      connection.id,
      "task-a",
      "result-a",
    );
    expect(result.scope.connectionId).toBe(a.connection.id);
    expect(result.scope.deviceId).toBe(a.pairing.deviceId);
  });
});
