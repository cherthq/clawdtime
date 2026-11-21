// The caller's own words on the call, from the transcription that comes with the voice model.
// The voice model decides what to do from sound, and it can decide wrongly: in a test call it turned the wide
// picture on for a caller who had not asked. So a tool that can cut what the caller sees acts only when the
// caller's own words asked for it. The words of a sentence often arrive a moment after the model has acted on
// its sound, so a check can wait for them. The words stay in memory for a short time and go nowhere.

/** Words of a caller who asks for a wide or a large picture, or who holds the phone sideways. */
export const WIDE_WORDS =
  /\b(?:side\s?ways|landscape|horizontal(?:ly)?|rotat\w*|turn\w* (?:the|my|this) phone|wide\w*|full width|bigger|larger|large)\b/i;

/**
 * Keeps what the caller said in the last moments.
 *  - `add(text, isFinal)` takes a piece of the caller's speech. A piece that is not final replaces the one before.
 *  - `recent(ms)` is the text of the last `ms`.
 *  - `said(pattern, { ms, waitMs })` resolves true as soon as the words of the last `ms` fit the pattern, and
 *    false when they do not within `waitMs`.
 *  - `stop()` ends every wait with false.
 * @param {{ now?: () => number, keepMs?: number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} [options]
 */
export function makeWords({
  now = Date.now,
  keepMs = 30000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let lines = [],
    partial = null,
    stopped = false;
  const waiting = new Set();
  const recent = (ms = keepMs) => {
    const from = now() - ms;
    return [...lines, ...(partial ? [partial] : [])]
      .filter((line) => line.at >= from)
      .map((line) => line.text)
      .join(" ");
  };
  const check = () => {
    for (const entry of [...waiting])
      if (entry.pattern.test(recent(entry.ms))) entry.done(true);
  };
  return {
    add(text, isFinal = true) {
      if (stopped || typeof text !== "string" || !text.trim()) return;
      const line = { text: text.trim().slice(0, 500), at: now() };
      if (isFinal) {
        partial = null;
        lines = [...lines, line]
          .filter((item) => item.at >= now() - keepMs)
          .slice(-20);
      } else partial = line;
      check();
    },
    recent,
    said(pattern, { ms = 20000, waitMs = 2500 } = {}) {
      if (stopped) return Promise.resolve(false);
      if (pattern.test(recent(ms))) return Promise.resolve(true);
      return new Promise((resolve) => {
        const entry = {
          pattern,
          ms,
          done(value) {
            clearTimer(timer);
            waiting.delete(entry);
            resolve(value);
          },
        };
        const timer = setTimer(() => entry.done(false), waitMs);
        waiting.add(entry);
      });
    },
    stop() {
      stopped = true;
      lines = [];
      partial = null;
      for (const entry of [...waiting]) entry.done(false);
    },
  };
}
