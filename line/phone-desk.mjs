import { randomUUID } from "node:crypto";
import { ask as standaloneAsk, run, settings } from "./desk.mjs";

const unavailable =
  "The desktop connection is unavailable for this call. No new computer action was sent.";
const unknown =
  "The request may have reached the Mac, but its outcome is unknown. I did not send it again. Check its status before repeating the request.";

/** One call owns one expiring desktop admission. All identities and text are
 * transient. A missing/failed configured desktop never falls back to another
 * supervisor, and an uncertain CLI response is never retried. */
export function makePhoneDesk({
  enabled = Boolean(process.env.CLAWDTIME_DESKTOP_STATE),
  callId = randomUUID(),
  now = Date.now,
  setTimer = setInterval,
  clearTimer = clearInterval,
  execute = (args) =>
    run(settings.clawdtime, args, {
      cwd: settings.project,
      env: {
        ...process.env,
        ...(process.env.OPENAI_API_KEY
          ? { CLAWDTIME_OPENAI_API_KEY: process.env.OPENAI_API_KEY }
          : {}),
      },
      timeout: args[1] === "chat" ? 120_000 : 10_000,
    }),
  fallback = standaloneAsk,
  diagnostic = () => {},
} = {}) {
  let opening = null,
    closing = null,
    timer = null,
    renewing = false;
  let closed = false,
    ready = false,
    expiresAt = 0;
  const requests = new Map();
  const command = async (operation, ...args) => {
    try {
      const result = await execute(["phone", operation, callId, ...args]);
      // CLI may use a nonzero exit for a structured refusal. Its bounded
      // result is still useful; raw stderr and errors are never spoken.
      const value = JSON.parse(result.stdout);
      if (
        !value ||
        typeof value !== "object" ||
        typeof value.ok !== "boolean" ||
        (result.ok === false && value.ok)
      )
        return { ok: false, code: "outcome_unknown" };
      return value;
    } catch {
      return { ok: false, code: "outcome_unknown" };
    }
  };
  const admitted = (result) =>
    result.ok === true &&
    Number.isFinite(result.expiresAt) &&
    result.expiresAt > now() &&
    result.expiresAt <= now() + 60_000;
  const close = () => {
    if (closing) return closing;
    closed = true;
    ready = false;
    if (timer !== null) clearTimer(timer);
    timer = null;
    closing = (async () => {
      if (!enabled || !opening) return;
      await opening;
      // Even uncertain admission gets one close: it may have reached the
      // service. Failure stays unknown; the server's lease must expire it.
      const result = await command("close");
      diagnostic(result.ok ? "phone_closed" : "phone_close_unknown");
    })();
    return closing;
  };
  const renew = async () => {
    if (closed || !ready || renewing) return;
    if (expiresAt <= now()) {
      ready = false;
      diagnostic("phone_expired");
      await close();
      return;
    }
    renewing = true;
    const result = await command("renew");
    renewing = false;
    if (closed) return;
    if (!admitted(result)) {
      ready = false;
      diagnostic("phone_renewal_failed");
      await close();
      return;
    }
    expiresAt = result.expiresAt;
  };
  const open = () => {
    if (opening) return opening;
    if (closed) return Promise.resolve(false);
    opening = (async () => {
      if (!enabled) return true;
      const result = await command("open");
      if (closed) return false;
      if (!admitted(result)) {
        diagnostic("phone_unavailable");
        // Do not await close inside opening: close waits for this promise.
        queueMicrotask(() => {
          void close();
        });
        return false;
      }
      ready = true;
      expiresAt = result.expiresAt;
      timer = setTimer(() => {
        void renew();
      }, 5000);
      timer?.unref?.();
      diagnostic("phone_opened");
      return true;
    })();
    return opening;
  };
  return {
    open,
    close,
    renew,
    async stop() {
      if (closed) return unavailable;
      if (!enabled) return fallback("stop");
      await open();
      if (closed || !ready || expiresAt <= now()) return unavailable;
      // Reduction-only endpoint bypasses a pending supervisor request.
      const result = await command("stop");
      if (result.ok)
        return typeof result.reply?.text === "string"
          ? result.reply.text
          : "Stop requested for this call's computer work.";
      ready = false;
      void close();
      return "I could not verify the stop result. This call's desktop connection has been closed; check the Mac before continuing.";
    },
    async ask(text, { requestId = randomUUID(), presentation } = {}) {
      if (!enabled) return closed ? unavailable : fallback(text);
      if (typeof text !== "string" || !text.trim() || text.length > 2000)
        return "That request is empty or too long. No new action was sent.";
      const payload = JSON.stringify({
        text,
        ...(presentation ? { presentation } : {}),
      });
      const prior = requests.get(requestId);
      if (prior) return prior.payload === payload ? prior.result : unavailable;
      if (closed) return unavailable;
      await open();
      if (closed || !ready || expiresAt <= now()) return unavailable;
      // Another tool may have joined while admission was pending.
      const admittedPrior = requests.get(requestId);
      if (admittedPrior)
        return admittedPrior.payload === payload
          ? admittedPrior.result
          : unavailable;
      if (requests.size >= 256) return unavailable;
      const delivery = Promise.withResolvers();
      requests.set(requestId, { payload, result: delivery.promise });
      void command("chat", requestId, payload).then((result) => {
        if (
          result.ok &&
          typeof result.reply?.text === "string" &&
          result.reply.text.length <= 20000
        ) {
          diagnostic("phone_request_returned");
          delivery.resolve(result.reply.text);
        } else if (result.code === "phone_request_cancelled") {
          diagnostic("phone_request_cancelled");
          delivery.resolve(
            "The request was canceled. Work already submitted may have taken effect; check its status before repeating it.",
          );
        } else {
          const uncertain =
            result.ok ||
            result.code === "outcome_unknown" ||
            result.code === "phone_request_uncertain";
          diagnostic(
            uncertain ? "phone_request_unknown" : "phone_request_refused",
          );
          if (uncertain) {
            ready = false;
            void close();
          }
          delivery.resolve(uncertain ? unknown : unavailable);
        }
      });
      return delivery.promise;
    },
  };
}
