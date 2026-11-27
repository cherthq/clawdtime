import { randomUUID } from "node:crypto";
import jpeg from "jpeg-js";
import { makeProactiveVideo } from "./proactive-outbound.mjs";
import { WIDTH, HEIGHT } from "./screen.mjs";

/** A caller who has not verified within this time is released (the
 * coordinator gives each call its own deadline, never longer than this). */
export const VERIFY_LIMIT_MS = 90_000;

/** Trusted voice adapter. The caller supplies speech only, never routing IDs.
 * It has no local CLI, memory, job watcher, or desktop fallback.
 * `end(reason)` ends the call (for example, removes its room). The desk calls
 * it when the caller does not verify before the deadline. */
export async function makeSharedDesk({
  origin,
  token,
  roomId,
  request = fetch,
  now = Date.now,
  claim = true,
  end = null,
  verifyLimitMs = VERIFY_LIMIT_MS,
}) {
  const url = new URL(origin);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    token.length < 32
  )
    throw Error("shared_line_configuration_required");
  const post = async (path, data) => {
    const response = await request(`${url.origin}${path}`, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(
        data.operation?.action === "chat" ? 125_000 : 30_000,
      ),
    });
    if (!response.ok) throw Error("shared_request_refused");
    return response.json();
  };
  let call = await post("/line/room", { roomId });
  if (
    call.roomId !== roomId ||
    (!call.id && !call.waiting) ||
    !call.participantId
  )
    throw Error("shared_room_mismatch");
  if (claim) await post("/line/room/claim", { roomId, workerId: randomUUID() });
  let bound = false,
    grantId = null,
    closed = false,
    renewTimer = null,
    renewing = false,
    lastTaskId = null,
    activeVideo = null,
    verifyTimer = null,
    proving = null;
  const command = async (operation, requestId = randomUUID()) => {
    if (!bound || closed || !grantId) throw Error("shared_call_not_authorized");
    return post("/line/command", {
      callId: call.id,
      grantId,
      requestId,
      operation,
    });
  };
  // The single line slot is never held by a caller who does not verify.
  const release = async () => {
    if (proving) await proving.catch(() => {});
    if (grantId || closed) return;
    closed = true;
    try {
      await post("/line/release", { roomId });
    } catch {
      /* the coordinator also releases the call at its own deadline */
    }
    try {
      await end?.("verification_expired");
    } catch {
      /* the provider cleanup still ends the call */
    }
  };
  let closing;
  const close = () => {
    if (closing) return closing;
    closed = true;
    clearTimeout(verifyTimer);
    clearInterval(renewTimer);
    const closingGrant = grantId;
    grantId = null;
    closing = (async () => {
      try {
        if (closingGrant)
          await post("/line/command", {
            callId: call.id,
            grantId: closingGrant,
            requestId: randomUUID(),
            operation: { action: "close" },
          });
      } catch {
        /* local lease expires independently */
      }
    })();
    return closing;
  };
  return {
    async bindCaller(identity) {
      if (identity !== call.participantId || closed) return false;
      const deadline = now() + 120000;
      while (
        (call.waiting || call.awaitingAnswer) &&
        !closed &&
        now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        call = await post("/line/room", { roomId });
      }
      bound =
        !closed &&
        !call.waiting &&
        !call.awaitingAnswer &&
        !!call.id &&
        call.roomId === roomId &&
        identity === call.participantId;
      if (bound) {
        const given = Number.isFinite(call.verifyInMs)
          ? call.verifyInMs
          : verifyLimitMs;
        verifyTimer = setTimeout(
          () => void release(),
          Math.max(0, Math.min(verifyLimitMs, given)),
        );
        verifyTimer.unref?.();
      }
      return bound;
    },
    async open() {
      return !closed;
    },
    close,
    greeting() {
      return "This is ClawdTime. No Mac is connected yet. On your paired Mac, run clawdtime shared prove, then say the eight-digit code that it shows.";
    },
    // This identifier grants no authority on its own. Only the paired Mac,
    // over its own device connection, receives the short-lived call code.
    callId: call.id,
    video: () => {
      const video = makeProactiveVideo({
        width: WIDTH,
        height: HEIGHT,
        now,
        client: {
          active: () => bound && !closed && !!grantId,
          status: async () => ({
            channel: "phone_walkthrough",
            sharingAllowed: bound && !closed && !!grantId,
          }),
          windowFrame: async () => {
            const result = await command({ action: "frame" });
            const frame = result.frame;
            if (
              !result.ok ||
              !frame ||
              typeof frame.jpeg !== "string" ||
              frame.jpeg.length > 8_000_000 ||
              frame.capturedAt > now() + 500 ||
              now() - frame.capturedAt > 1000
            )
              return null;
            const pixels = jpeg.decode(Buffer.from(frame.jpeg, "base64"), {
              useTArray: true,
              maxResolutionInMP: 4,
              maxMemoryUsageInMB: 64,
            });
            if (
              pixels.width !== frame.width ||
              pixels.height !== frame.height ||
              closed
            )
              return null;
            return {
              frameId: randomUUID(),
              rgba: pixels.data,
              width: frame.width,
              height: frame.height,
              capturedAt: frame.capturedAt,
              expiresAt: frame.capturedAt + 1000,
            };
          },
        },
      });
      const hide = video.hide.bind(video);
      video.hide = () => {
        hide();
        if (grantId && !closed)
          void command({ action: "hide" }).catch(() => {});
      };
      activeVideo = video;
      return video;
    },
    async ask(text, { requestId } = {}) {
      if (!bound || closed || !requestId)
        return "This call is unavailable. No action was sent.";
      if (!grantId) {
        const code =
          /^\s*(?:my code is\s+|the code is\s+)?(\d{8})[.!]?\s*$/i.exec(
            text,
          )?.[1];
        if (!code)
          return "On your paired Mac, run clawdtime shared prove, then say the eight-digit code that it shows. No computer is connected yet.";
        proving = post("/line/proof-turn", {
          lineId: call.lineId,
          providerCallId: call.providerCallId,
          roomId: call.roomId,
          participantId: call.participantId,
          turnId: requestId,
          code,
          expiresAt: now() + 10_000,
        });
        let proof;
        try {
          proof = await proving;
        } finally {
          proving = null;
        }
        if (proof.state !== "admitted" || closed)
          return "That code did not connect your paired Mac. No action was sent.";
        grantId = proof.call.scope.grantId;
        clearTimeout(verifyTimer);
        const result = await command({ action: "open" });
        if (!result.ok) {
          await close();
          return "Your Mac could not open this call. No task was sent.";
        }
        renewTimer = setInterval(() => {
          if (renewing || closed) return;
          renewing = true;
          void command({ action: "renew" })
            .then(
              (result) => {
                if (!result.ok) void close();
              },
              () => {
                void close();
              },
            )
            .finally(() => {
              renewing = false;
            });
        }, 5_000);
        renewTimer.unref?.();
        if (call.callbackTaskId) {
          const result = await command(
            { action: "walkthrough" },
            "initial-walkthrough",
          );
          if (!result.ok || !result.walkthrough)
            return "Your Mac connected, but the original task result could not be verified. No other task was substituted.";
          if (result.walkthrough.opened) await activeVideo?.show();
          return `Your coding process finished. Its result report says: ${result.walkthrough.text}. ${result.walkthrough.opened ? "Opening the report and screen sharing were requested; handset visibility is not confirmed." : "The result report is available by voice. Report opening is disabled on your Mac."}`;
        }
        return "Your paired Mac is connected. What would you like me to do?";
      }
      if (/^\s*(?:yes,?\s+)?call me when it finishes[.!]?\s*$/i.test(text)) {
        if (!lastTaskId)
          return "Start a task on this call before requesting its completion callback.";
        const consent = await post("/line/callback-request", {
          callId: call.id,
          grantId,
          taskId: lastTaskId,
        }).catch(() => ({ ok: false }));
        return consent.ok
          ? "A completion callback is requested for that exact task. It waits until the line is free and your Mac is connected."
          : "The shared callback service is unavailable. No callback was requested.";
      }
      const result = await command(
        { action: "chat", requestId, text },
        requestId,
      );
      if (!result.ok)
        return "The request was not verified. I will not repeat it automatically.";
      if (result.taskId) lastTaskId = result.taskId;
      return typeof result.reply?.text === "string"
        ? result.reply.text
        : "No verified reply was returned.";
    },
    async stop() {
      if (!grantId) return "No computer is connected to this call.";
      const result = await command({ action: "stop" });
      return (
        result.reply?.text ??
        "Stop was requested; its outcome was not verified."
      );
    },
  };
}
