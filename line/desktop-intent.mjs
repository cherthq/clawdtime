const refused = () => ({
  ok: false,
  message:
    "I could not bind that request to fresh, unused words from you. No command was sent. Please repeat the request.",
});

// This compares provenance, not intent. Navigation is interpreted by the
// supervisor's goal-only model, never by a phrase list on the phone line.
const sameWords = (a, b) =>
  a.trim().replace(/\s+/g, " ") === b.trim().replace(/\s+/g, " ");

/** Bind each supervisor tool call to one final human utterance from this call.
 * Forward the full original text, never the voice model's paraphrase. Consume
 * before dispatch even if delivery fails. Screen text, TTS, recalled turns and
 * combined recent-speech buffers must never be passed to add(). */
export function makeCallerRequestBinding({
  now = Date.now,
  maxAgeMs = 20000,
  waitMs = 2500,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let final = null,
    stopped = false,
    lastEventAt = -Infinity;
  const waiting = new Set();
  const seenFinals = new Map();
  const fresh = () =>
    final && now() >= final.at && now() - final.at <= maxAgeMs;
  const claim = (request) => {
    if (stopped || !fresh() || final.used) return refused();
    // Spend the utterance before matching/delivery. A tool cannot change the
    // target through a paraphrase or repair a mismatch by cycling alternatives.
    final.used = true;
    if (!sameWords(request, final.text)) return refused();
    return { ok: true, text: final.text };
  };
  return {
    add(text, isFinal = true, { itemId = null, createdAt = now() } = {}) {
      if (
        stopped ||
        typeof text !== "string" ||
        (isFinal && !text.trim()) ||
        text.length > 16000
      )
        return;
      const at = now();
      if (
        !Number.isFinite(createdAt) ||
        createdAt > at ||
        at - createdAt > maxAgeMs ||
        createdAt < lastEventAt
      )
        return;
      // IDs are supplied by UserInputTranscribed, not by the voice model.
      // Retain them through the freshness window to reject duplicate finals.
      for (const [id, time] of seenFinals)
        if (at - time > maxAgeMs) seenFinals.delete(id);
      const id =
        typeof itemId === "string" && itemId
          ? itemId
          : `event:${createdAt}:${text}`;
      if (seenFinals.has(id)) return;
      lastEventAt = createdAt;
      final = isFinal ? { text, at: createdAt, used: false } : null;
      if (isFinal) {
        seenFinals.set(id, createdAt);
        for (const entry of [...waiting]) entry.done(claim(entry.request));
      }
    },
    take(request) {
      if (
        typeof request !== "string" ||
        !request.trim() ||
        request.length > 16000
      )
        return Promise.resolve(refused());
      // Emergency cancellation only reduces authority. It must not wait for
      // transcription. This safety path does not classify navigation requests.
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
      seenFinals.clear();
      for (const entry of [...waiting]) entry.done(refused());
    },
  };
}
