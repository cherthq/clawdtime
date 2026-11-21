// The standalone line cannot import the service's TypeScript at runtime. Keep
// this exact-command grammar aligned with connectors/computer/desktop.ts.
export function desktopDirection(goal) {
  if (typeof goal !== "string") return undefined;
  const words = goal
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, "")
    .replace(/^please\s+/, "")
    .replace(/\s+please$/, "")
    .replace(/\s+/g, " ");
  if (
    /^(?:go|switch|move) back to (?:the )?previous (?:desktop|space)$/.test(
      words,
    ) ||
    /^(?:go|switch|move) to (?:the )?previous (?:desktop|space)$/.test(words)
  )
    return "previous";
  const match = words.match(
    /^(?:(?:switch|go|move) to (?:the )?(?:desktop|space) (?:on |to )?(?:the )?(left|right)|(?:move|switch|go) (?:one |a )?(?:desktop|space) (left|right)|(?:switch|move) (left|right) (?:one |a )?(?:desktop|space))$/,
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

const refused = () => ({
  ok: false,
  message:
    "I could not match that command to a fresh, unused final request from you. No command was sent. Please say the desktop direction again.",
});

/** Bind a directional model tool to one final human utterance, consumed before
 * dispatch even if delivery fails. A partial/new utterance retires the old one.
 * Text stays transient; a combined recent-speech buffer cannot authorize input. */
export function makeDesktopIntent({
  now = Date.now,
  maxAgeMs = 20000,
  waitMs = 2500,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let final = null,
    stopped = false;
  const waiting = new Set();
  const fresh = () =>
    final && now() >= final.at && now() - final.at <= maxAgeMs;
  const claim = (request) => {
    if (stopped || !fresh()) return refused();
    const requested = desktopDirection(request);
    const direction = desktopDirection(final.text);
    if (!requested && !direction) return { ok: true, text: request };
    if (final.used) return refused();
    final.used = true;
    if (!direction || requested !== direction) return refused();
    return { ok: true, text: final.text };
  };
  return {
    add(text, isFinal = true) {
      if (stopped || typeof text !== "string" || !text.trim()) return;
      final = isFinal ? { text, at: now(), used: false } : null;
      if (isFinal)
        for (const entry of [...waiting]) entry.done(claim(entry.request));
    },
    take(request) {
      // Stopping grants no new input authority and must never wait for speech
      // transcription or an unused directional token.
      if (
        !stopped &&
        /^(?:please\s+)?(?:stop|cancel|abort)(?:\s+(?:computer(?: task)?|execution|browser(?: task)?|sharing|control|listening))?[.!?]*$/i.test(
          request.trim(),
        )
      ) {
        if (final) final.used = true;
        for (const entry of [...waiting]) entry.done(refused());
        return Promise.resolve({ ok: true, text: request });
      }
      if (stopped || fresh()) return Promise.resolve(claim(request));
      return new Promise((resolve) => {
        const entry = {
          request,
          done(result) {
            clearTimer(timer);
            waiting.delete(entry);
            resolve(result);
          },
        };
        const timer = setTimer(() => entry.done(refused()), waitMs);
        waiting.add(entry);
      });
    },
    stop() {
      stopped = true;
      final = null;
      for (const entry of [...waiting]) entry.done(refused());
    },
  };
}
