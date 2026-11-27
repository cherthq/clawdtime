import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { SharedNumber } from "./control/shared-number.js";
import { SharedNumberRelay } from "./control/shared-number-relay.js";
import {
  SharedPhoneIdentity,
  signInClient,
} from "./pairing/shared-phone-identity.js";
import { Store } from "./storage/store.js";
import { DomainError, equal, hash } from "./storage/security.js";
import {
  routingId,
  routingProviderEventSchema,
  callProofTurnSchema,
} from "./shared-number-contracts.js";
import {
  sharedOperationSchema,
  sharedResultSchema,
} from "./shared-relay-contracts.js";

const tooLarge = (c: Context) =>
  c.json({ ok: false, code: "request_too_large" }, 413);

/** Separate coordinator. This factory does not claim a line or start polling.
 * The line token is a trusted server-to-server boundary, never a member token.
 * Only the provider handler and its original-turn adapter may possess it. */
export function createSharedNumberApp(options: {
  store: Store;
  lineId: string;
  proofKey: string;
  identityKey: string;
  lineToken: string;
  sendCode(recipient: string, code: string, key: string): Promise<boolean>;
  /** Numbers that may get a sign-in text. Current members need no entry. */
  invited?: readonly string[];
  now?: () => number;
  relayTimeoutMs?: number;
  callbacksEnabled?: boolean;
  /** True only when every request comes through a proxy on this host that
   * appends the client address to X-Forwarded-For. Otherwise the header is
   * ignored and the client is the socket address. */
  behindProxy?: boolean;
}) {
  if (options.lineToken.length < 32) throw Error("shared_line_token_required");
  const identity = new SharedPhoneIdentity(options.store, {
    lineId: options.lineId,
    key: options.identityKey,
    invited: options.invited,
    send: options.sendCode,
    now: options.now,
  });
  const trusted = new WeakSet<object>();
  const evidence = (raw: object) => {
    trusted.add(raw);
    return raw;
  };
  const qualified = (raw: unknown) => {
    if (!raw || typeof raw !== "object" || !trusted.has(raw))
      throw new DomainError(403, "untrusted_evidence");
    return raw;
  };
  const router = new SharedNumber(options.store, {
    lineId: options.lineId,
    proofKey: options.proofKey,
    now: options.now,
    verifiers: {
      account: (proof) => identity.account(proof),
      alias: (proof) => identity.alias(proof),
      provider: async (raw) => routingProviderEventSchema.parse(qualified(raw)),
      callProofTurn: async (raw) => callProofTurnSchema.parse(qualified(raw)),
    },
  });
  const relay = new SharedNumberRelay(
    router,
    options.store,
    options.now,
    options.relayTimeoutMs,
  );
  const app = new Hono();
  const bearer = (header?: string) =>
    header?.startsWith("Bearer ") ? header.slice(7) : "";
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  // Check the device credential before any byte of a device body is read.
  app.use("/device/*", async (c, next) => {
    router.authenticateDevice(bearer(c.req.header("authorization")));
    await next();
  });
  // Every body is small. Only a device's screen frame result can be large.
  const small = bodyLimit({ maxSize: 32_768, onError: tooLarge });
  const frame = bodyLimit({ maxSize: 8_100_000, onError: tooLarge });
  app.use("*", (c, next) =>
    (c.req.path === "/device/result" ? frame : small)(c, next),
  );
  app.use("/line/*", async (c, next) => {
    if (
      !equal(
        hash(bearer(c.req.header("authorization"))),
        hash(options.lineToken),
      )
    )
      return c.json({ ok: false, code: "line_unauthorized" }, 403);
    await next();
  });
  app.notFound((c) => c.json({ ok: false, code: "not_found" }, 404));
  app.onError((error, c) =>
    c.json(
      {
        ok: false,
        code: error instanceof DomainError ? error.message : "request_refused",
      },
      error instanceof DomainError ? (error.status as 403 | 409 | 429) : 400,
    ),
  );
  app.get("/health", (c) =>
    c.json({
      service: "shared-number",
      coordinatorAvailable: true,
      sharedCallsQualified: false,
      physicalAcceptance: false,
      callbacksEnabled: options.callbacksEnabled === true,
      lineOwnership: "external",
    }),
  );
  // A web page can send text/plain or a form without a preflight; not JSON.
  app.use("/auth/*", async (c, next) => {
    if (!/^application\/json\s*(;|$)/i.test(c.req.header("content-type") ?? ""))
      return c.json({ ok: false, code: "json_required" }, 415);
    await next();
  });
  app.post("/auth/start", async (c) => {
    const { recipient } = z
      .object({ recipient: z.string().max(32) })
      .strict()
      .parse(await c.req.json());
    const peer = (
      c.env as { incoming?: { socket?: { remoteAddress?: string } } }
    )?.incoming?.socket?.remoteAddress;
    // Anyone can send this header. Only a proxy that appends it is trusted.
    const forwarded = options.behindProxy
      ? c.req.header("x-forwarded-for")
      : undefined;
    return c.json(
      await identity.start(recipient, signInClient(peer, forwarded)),
    );
  });
  app.post("/auth/verify", async (c) => {
    const input = z
      .object({ challengeId: z.string().max(200), code: z.string().max(32) })
      .strict()
      .parse(await c.req.json());
    return c.json(identity.verify(input.challengeId, input.code));
  });
  // An empty body is an empty object. Bodies stay small and strict.
  const body = async (c: Context) => {
    const text = await c.req.text();
    return text.trim() ? (JSON.parse(text) as unknown) : {};
  };
  app.post("/account/invite", async (c) => {
    const proof = bearer(c.req.header("authorization"));
    const { replace } = z
      .object({ replace: z.boolean().optional() })
      .strict()
      .parse(await body(c));
    await router.enroll(proof, proof);
    return c.json(await router.invite(proof, { replace }));
  });
  app.post("/account/revoke", async (c) => {
    const options = z
      .object({
        permanent: z.boolean().optional(),
        deviceCredential: z.string().max(512).optional(),
      })
      .strict()
      .parse(await body(c));
    await router.revoke(bearer(c.req.header("authorization")), options);
    return c.json({ ok: true });
  });
  app.post("/pair/accept", async (c) => {
    const { invitation, acceptance } = z
      .object({ invitation: z.string().max(200), acceptance: z.unknown() })
      .strict()
      .parse(await c.req.json());
    return c.json(router.acceptInvitation(invitation, acceptance));
  });
  app.post("/device/connect", async (c) => {
    const { instanceId } = z
      .object({ instanceId: routingId })
      .strict()
      .parse(await c.req.json());
    return c.json(
      router.connect(bearer(c.req.header("authorization")), instanceId),
    );
  });
  // The paired Mac shows this code to the person at that Mac. The account
  // sign-in never yields a call code.
  app.post("/device/call-proof", async (c) => {
    const { callId } = z
      .object({ callId: routingId.optional() })
      .strict()
      .parse(await c.req.json());
    return c.json(
      router.issueCallProof(bearer(c.req.header("authorization")), callId),
    );
  });
  // The Mac replaces its own credential. A stolen credential is replaced
  // through the signed-in account instead: /account/invite with replace.
  app.post("/device/rotate", async (c) => {
    z.object({})
      .strict()
      .parse(await body(c));
    return c.json({
      credential: router.rotateCredential(
        bearer(c.req.header("authorization")),
      ),
    });
  });
  for (const action of ["heartbeat", "disconnect", "poll"] as const)
    app.post(`/device/${action}`, async (c) => {
      const { connectionId } = z
        .object({ connectionId: routingId })
        .strict()
        .parse(await c.req.json());
      const credential = bearer(c.req.header("authorization"));
      if (action === "poll")
        return c.json({
          command: await relay.poll(credential, connectionId, c.req.raw.signal),
        });
      if (action === "heartbeat")
        return c.json(router.heartbeat(credential, connectionId));
      router.disconnect(credential, connectionId);
      return c.json({ ok: true });
    });
  app.post("/device/result", async (c) => {
    const { connectionId, id, result } = z
      .object({
        connectionId: routingId,
        id: routingId,
        result: sharedResultSchema,
      })
      .strict()
      .parse(await c.req.json());
    relay.respond(
      bearer(c.req.header("authorization")),
      connectionId,
      id,
      result,
    );
    return c.json({ ok: true });
  });
  app.post("/device/completion", async (c) => {
    const { connectionId, taskId, resultId } = z
      .object({
        connectionId: routingId,
        taskId: routingId,
        resultId: routingId,
      })
      .strict()
      .parse(await c.req.json());
    const result = router.completeTask(
      bearer(c.req.header("authorization")),
      connectionId,
      taskId,
      resultId,
    );
    return c.json({ id: result.id, state: result.state });
  });
  app.post("/line/event", async (c) =>
    c.json(
      await router.providerEvent(
        evidence(routingProviderEventSchema.parse(await c.req.json())),
      ),
    ),
  );
  app.post("/line/room", async (c) => {
    const { roomId } = z
      .object({ roomId: routingId })
      .strict()
      .parse(await c.req.json());
    const calls = options.store
      .all<import("./shared-number-contracts.js").SharedCall>(
        "shared_number_call",
      )
      .filter(
        (call) =>
          call.roomId === roomId &&
          call.lineId === options.lineId &&
          ["unknown_identity", "admitted"].includes(call.state),
      );
    if (calls.length === 0) {
      const callbacks = options.store
        .all<import("./shared-number-contracts.js").SharedCallbackOwnership>(
          "shared_number_callback",
        )
        .filter(
          (callback) =>
            callback.roomId === roomId &&
            ["preparing", "dialing"].includes(callback.state),
        );
      if (callbacks.length === 1)
        return c.json({
          roomId,
          participantId: "shared-bridge",
          waiting: true,
        });
    }
    if (calls.length !== 1)
      return c.json({ ok: false, code: "room_unavailable" }, 409);
    const call = calls[0]!;
    const verifyBy =
      call.state === "unknown_identity" ? router.verifyBy(call) : undefined;
    // The trusted voice worker gets only its binding, never another member's data.
    return c.json({
      id: call.id,
      lineId: call.lineId,
      providerCallId: call.providerCallId,
      roomId: call.roomId,
      participantId: call.participantId,
      callbackTaskId: call.callbackTaskId,
      awaitingAnswer: !!call.callbackTaskId && !call.activatedAt,
      // The worker ends the call if it is not verified within this time.
      ...(verifyBy !== undefined
        ? { verifyInMs: Math.max(0, verifyBy - (options.now ?? Date.now)()) }
        : {}),
    });
  });
  app.post("/line/release", async (c) => {
    const { roomId } = z
      .object({ roomId: routingId })
      .strict()
      .parse(await c.req.json());
    return c.json({ ok: true, released: router.releaseRoom(roomId) });
  });
  app.post("/line/room/claim", async (c) => {
    const { roomId, workerId } = z
      .object({ roomId: routingId, workerId: routingId })
      .strict()
      .parse(await c.req.json());
    options.store.transaction(() => {
      const known =
        options.store
          .all<import("./shared-number-contracts.js").SharedCall>(
            "shared_number_call",
          )
          .some(
            (call) =>
              call.roomId === roomId &&
              ["unknown_identity", "admitted"].includes(call.state),
          ) ||
        options.store
          .all<import("./shared-number-contracts.js").SharedCallbackOwnership>(
            "shared_number_callback",
          )
          .some(
            (callback) =>
              callback.roomId === roomId &&
              ["preparing", "dialing"].includes(callback.state),
          );
      if (!known) throw new DomainError(409, "shared_room_unavailable");
      const prior = options.store.get<{ id: string; workerId: string }>(
        "shared_voice_claim",
        roomId,
      );
      if (prior && prior.workerId !== workerId)
        throw new DomainError(409, "shared_voice_already_claimed");
      options.store.put("shared_voice_claim", { id: roomId, workerId });
    });
    return c.json({ ok: true });
  });
  app.post("/line/proof-turn", async (c) =>
    c.json(
      await router.proveCall(
        evidence(callProofTurnSchema.parse(await c.req.json())),
      ),
    ),
  );
  app.post("/line/command", async (c) => {
    const input = z
      .object({
        callId: routingId,
        grantId: routingId,
        requestId: routingId,
        operation: sharedOperationSchema,
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await relay.dispatch(
        input.callId,
        input.grantId,
        input.requestId,
        input.operation,
      ),
    );
  });
  app.post("/line/callback-request", async (c) => {
    if (!options.callbacksEnabled)
      return c.json({ ok: false, code: "shared_callbacks_unavailable" }, 409);
    const input = z
      .object({ callId: routingId, grantId: routingId, taskId: routingId })
      .strict()
      .parse(await c.req.json());
    return c.json(
      router.requestCallback(input.callId, input.grantId, input.taskId),
    );
  });
  app.post("/line/callback/claim", (c) =>
    c.json({
      callback: options.callbacksEnabled ? router.claimCallback() : null,
    }),
  );
  for (const action of [
    "dialing",
    "unknown",
    "clean",
    "inspect",
    "bind",
  ] as const) {
    app.post(`/line/callback/${action}`, async (c) => {
      const input = z
        .object({ id: routingId, providerCallId: routingId.optional() })
        .strict()
        .parse(await c.req.json());
      if (action === "dialing") router.callbackDialing(input.id);
      if (action === "unknown") router.callbackUnknown(input.id);
      if (action === "clean") router.callbackClean(input.id);
      if (action === "bind") {
        if (!input.providerCallId) throw new Error("provider_call_required");
        router.bindCallback(input.id, input.providerCallId);
      }
      return c.json(router.callback(input.id));
    });
  }
  return {
    app,
    router,
    relay,
    providerEvent: (raw: unknown) =>
      router.providerEvent(evidence(routingProviderEventSchema.parse(raw))),
    close: () => relay.close(),
  };
}
