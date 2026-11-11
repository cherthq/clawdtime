import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { timingSafeEqual, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ClawdTime, DomainError } from "./attention/service.js";
import { ControlCoordinator } from "./control/coordinator.js";
import type {
  AgentSession,
  AttentionRequest,
  CallSession,
  ControlLease,
  Pairing,
  ActionReceipt,
} from "./contracts.js";
import { HumanRouter } from "./control/human-router.js";

export interface AppOptions {
  origin: string;
  operatorToken?: string;
  mediaToken?: string;
  simulation: boolean;
  dispatchEnabled?: boolean;
}
const bearer = (value?: string) =>
  value?.startsWith("Bearer ") ? value.slice(7) : "";
function matches(a: string, b?: string) {
  return (
    !!b &&
    b.length >= 32 &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
const mediaId = (id: string) =>
  `ct_${createHash("sha256").update(id).digest("hex").slice(0, 40)}`;
export function createApp(
  service: ClawdTime,
  control: ControlCoordinator,
  human: HumanRouter,
  options: AppOptions,
) {
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 32_768 }));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    const origin = c.req.header("origin");
    if (origin && origin !== options.origin)
      return c.json({ error: "Origin is not allowed." }, 403);
    if (
      ["POST", "PUT", "DELETE", "PATCH"].includes(c.req.method) &&
      !c.req.header("content-type")?.startsWith("application/json")
    )
      return c.json({ error: "JSON required." }, 415);
    await next();
  });
  app.onError((err, c) =>
    c.json(
      {
        error:
          err instanceof DomainError || err instanceof z.ZodError
            ? err.message
            : "Request could not be completed. Check scoped state and readiness.",
      },
      err instanceof DomainError
        ? (err.status as 400)
        : err instanceof z.ZodError
          ? 400
          : 409,
    ),
  );
  app.get("/health", (c) =>
    c.json({
      ok: true,
      mode: options.simulation ? "simulation" : "standby-or-live",
      physicalAcceptance: false,
    }),
  );
  app.get("/", (c) =>
    c.html(
      readFileSync(new URL("../public/index.html", import.meta.url), "utf8"),
    ),
  );
  app.get("/pair", (c) =>
    c.html(
      readFileSync(new URL("../public/pair.html", import.meta.url), "utf8"),
    ),
  );
  app.get("/assets/:name", (c) => {
    const name = c.req.param("name");
    if (!["style.css", "pair.js"].includes(name)) return c.notFound();
    c.header(
      "Content-Type",
      name.endsWith("css") ? "text/css" : "text/javascript",
    );
    return c.body(
      readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8"),
    );
  });
  app.post("/api/pairing/claim", async (c) =>
    c.json({
      baseUrl: options.origin,
      ...service.claimPairing(await c.req.json()),
    }),
  );
  app.post("/api/sessions", async (c) =>
    c.json(
      service.registerSession(
        bearer(c.req.header("authorization")),
        await c.req.json(),
      ),
    ),
  );
  app.get("/api/doctor", (c) =>
    c.json(service.doctor(bearer(c.req.header("authorization")))),
  );
  app.post("/api/attention", async (c) => {
    const request = service.requestAttention(
      bearer(c.req.header("authorization")),
      await c.req.json(),
    );
    return c.json({ request }, 202);
  });
  app.get("/api/attention/:id", (c) =>
    c.json({
      request: service.status(
        bearer(c.req.header("authorization")),
        c.req.param("id"),
      ),
    }),
  );
  app.get("/api/attention/:id/result", (c) => {
    const token = bearer(c.req.header("authorization")),
      result = service.result(token, c.req.param("id")),
      session = service.authenticateSession(token);
    const leases = service.store
      .all<ControlLease>("lease")
      .filter((l) => l.requestId === result.request.id);
    return c.json({
      ...result,
      session,
      leases,
      actions: service.store
        .all<ActionReceipt>("action")
        .filter((a) => leases.some((l) => l.id === a.leaseId)),
    });
  });
  app.post("/api/attention/:id/ack", async (c) =>
    c.json({
      response: service.ack(
        bearer(c.req.header("authorization")),
        c.req.param("id"),
        (await c.req.json()).responseId,
      ),
    }),
  );
  app.post("/api/attention/:id/resume", async (c) =>
    c.json(
      service.resume(
        bearer(c.req.header("authorization")),
        c.req.param("id"),
        (await c.req.json()).controlEpoch,
      ),
    ),
  );
  app.post("/api/attention/:id/complete", async (c) =>
    c.json({
      request: service.complete(
        bearer(c.req.header("authorization")),
        c.req.param("id"),
        (await c.req.json()).text,
      ),
    }),
  );
  app.post("/api/sessions/yield", (c) =>
    c.json({
      session: service.yieldSession(bearer(c.req.header("authorization"))),
    }),
  );
  app.post("/api/sessions/heartbeat", (c) =>
    c.json({
      session: service.heartbeat(bearer(c.req.header("authorization"))),
    }),
  );
  app.post("/api/disconnect", async (c) => {
    const token = bearer(c.req.header("authorization")),
      doctor = service.doctor(token);
    const result = service.disconnect(token);
    await control.stopPairing(doctor.pairing.id);
    return c.json(result);
  });
  app.use("/internal/*", async (c, next) => {
    if (!matches(bearer(c.req.header("authorization")), options.operatorToken))
      return c.json({ error: "Operator authentication required." }, 401);
    await next();
  });
  app.get("/internal/readiness", (c) =>
    c.json({
      mode: service.transport.mode,
      pending: service.store.effects("pending").length,
      unknown: service.store.effects("unknown").length,
      activeCalls: service.store
        .all<CallSession>("call")
        .filter((s) => s.state !== "ended").length,
      physicalAcceptance: false,
    }),
  );
  app.post("/internal/pairing", async (c) => {
    const value = await c.req.json();
    const invite = service.createPairingInvite(value);
    return c.json({
      ...invite,
      url: `${options.origin}/pair#token=${encodeURIComponent(invite.token)}&device=${encodeURIComponent(value.deviceId)}&display=${encodeURIComponent(value.displayId)}`,
    });
  });
  app.post("/internal/simulation/call", async (c) => {
    if (!options.simulation) return c.notFound();
    const b = await c.req.json();
    return c.json(
      service.observeCall(b.requestId, b.state, b.qualified === true),
    );
  });
  app.post("/internal/simulation/human", async (c) => {
    if (!options.simulation) return c.notFound();
    return c.json(await human.receive(await c.req.json()));
  });
  app.post("/internal/drain", async (c) => {
    await service.drain({
      cleanupOnly: !(options.dispatchEnabled ?? options.simulation),
    });
    return c.json({ ok: true });
  });
  app.use("/media/*", async (c, next) => {
    if (!matches(bearer(c.req.header("authorization")), options.mediaToken))
      return c.json({ error: "Media authentication required." }, 401);
    await next();
  });
  function mediaContext(id: string) {
    const request = service.store
      .all<AttentionRequest>("attention")
      .find((r) => mediaId(r.id) === id);
    if (!request) throw new DomainError(404, "Unknown media session.");
    const pairing = service.store.get<Pairing>("pairing", request.pairingId)!;
    const call = service.store
      .all<CallSession>("call")
      .find((c) => c.requestId === request.id);
    const session = service.store.get<AgentSession>(
      "session",
      request.sessionId,
    )!;
    return { request, pairing, call, session };
  }
  app.get("/media/:id/policy", (c) => {
    const { request, pairing, call, session } = mediaContext(c.req.param("id")),
      now = Date.now();
    const open =
      !pairing.revokedAt &&
      session.state !== "stopped" &&
      now - (session.lastSeenAt ?? session.createdAt) <= 20_000 &&
      call?.state === "connected" &&
      call.remoteParticipantQualified &&
      request.deadline > now &&
      ["connected", "awaiting_input", "response_delivered"].includes(
        request.state,
      ) &&
      !service.store.state(`listening-stopped:${request.id}`);
    const lease = service.store
      .all<ControlLease>("lease")
      .find(
        (l) =>
          l.requestId === request.id &&
          l.state === "active" &&
          l.expiresAt > now,
      );
    const selection =
      open &&
      lease &&
      session.state === "yielded" &&
      session.controlEpoch === lease.epoch
        ? {
            leaseId: lease.id,
            deviceId: lease.deviceId,
            alias: "Paired Mac",
            memberId: lease.memberId,
            callId: lease.callId,
            displayId: Number(lease.displayId),
            mode: lease.mode,
            expiresAt: new Date(lease.expiresAt).toISOString(),
          }
        : undefined;
    return c.json({
      state: open ? "listening" : "ended",
      callId: call?.id,
      expiresAt: new Date(now + 20_000).toISOString(),
      ...(selection ? { screenSelection: selection } : {}),
    });
  });
  app.post("/media/:id/segments", async (c) => {
    const { request, pairing, call } = mediaContext(c.req.param("id")),
      b = await c.req.json();
    if (service.store.state(`listening-stopped:${request.id}`))
      return c.json({ captured: false, stopped: true });
    if (
      !call ||
      b.source !== "remote_participant" ||
      b.callId !== call.id ||
      b.participantIdentity !== `worker-${c.req.param("id")}`
    )
      throw new DomainError(403, "Unqualified audio source.");
    const heard = z.string().min(1).max(8000).parse(b.text);
    if (!/^(?:hey )?clawdtime[, :]+/i.test(heard))
      return c.json({
        captured: false,
        reason: "Say Hey ClawdTime, then answer or a control instruction.",
      });
    if (
      Math.abs(Date.now() - Date.parse(b.at)) > 10_000 ||
      !Number.isFinite(Date.parse(b.at))
    )
      throw new DomainError(409, "Stale speech.");
    const command = heard.replace(/^(?:hey )?clawdtime[, :]+/i, "");
    if (/^stop listening[.!]?$/i.test(command)) {
      service.store.saveState(`listening-stopped:${request.id}`, true);
      await control.stopPairing(pairing.id);
      return c.json({ captured: false, stopped: true });
    }
    const result = (await human.receive({
      eventId: `voice:${c.req.param("id")}:${b.id}`,
      requestId: request.id,
      memberId: pairing.memberId,
      lineId: pairing.lineId,
      conversationId: pairing.conversationId,
      channel: "voice",
      text: command,
      callId: call.id,
      qualifiedRemoteAudio: true,
    })) as { accepted?: boolean };
    return c.json({ ...result, captured: result.accepted === true });
  });
  app.post("/media/:id/screen-stopped", async (c) => {
    const { request, session } = mediaContext(c.req.param("id")),
      b = await c.req.json();
    const lease = service.store.get<ControlLease>("lease", String(b.leaseId));
    if (!lease || lease.requestId !== request.id)
      throw new DomainError(403, "Screen stop binding mismatch.");
    if (lease.state === "active") {
      service.store.put("lease", { ...lease, state: "unknown" });
      service.store.put("session", {
        ...session,
        controlEpoch: session.controlEpoch + 1,
      });
    }
    service.store.saveState(`view-started:${request.id}`, true);
    service.store.saveState(`view-stopped:${request.id}`, true);
    return c.json({ stopped: true });
  });
  app.post("/media/:id/failure", async (c) => {
    const { request, pairing } = mediaContext(c.req.param("id"));
    service.failCall(request.id);
    await control.stopPairing(pairing.id);
    return c.json({ ok: true });
  });
  return app;
}
