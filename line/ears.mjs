// When the agent listens to the call.
//
// A phone line is not a quiet microphone. Two things on it sound like a caller and are not one:
//  - Before FaceTime is ready, the call still connects. The agent then answers a sound, and that answer and the
//    greeting run into each other.
//  - While the agent speaks, its own voice comes back through the phone. The agent then stops itself in the
//    middle of a sentence, or answers what it said itself.
// So the agent listens only when the call is ready and the greeting is said, and not while it speaks, nor for a
// short moment after. A caller who wants to say something waits for the end of the sentence: the answers are
// short. With bargeIn, the agent also listens while it speaks, for a line that brings no voice back.

/** How long after its own last word the agent still does not listen: the end of its voice is still on the line. */
export const TAIL_MS = 600;
/** How long the greeting may take to start and end, before the agent listens whatever happened. */
export const GREETING_MS = 8000;
/** How long the agent waits for the signal that the call is ready, before it listens so that the caller can speak first. */
export const FALLBACK_MS = 15000;

/**
 * @param {{
 *   setListening: (on: boolean) => void,
 *   bargeIn?: boolean,
 *   tailMs?: number, greetingMs?: number, fallbackMs?: number,
 *   setTimer?: (run: () => void, ms: number) => unknown, clearTimer?: (timer: unknown) => void,
 * }} options `setListening` turns the audio input of the session on or off. It is called only on a change,
 *   and once at the start with false.
 */
export function makeEars({
  setListening,
  bargeIn = false,
  tailMs = TAIL_MS,
  greetingMs = GREETING_MS,
  fallbackMs = FALLBACK_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let open = false; // the call is ready and the greeting is over
  let greeting = false; // the ready signal came, and the greeting is not over yet
  let spoke = false; // the agent started to speak since the ready signal
  let speaking = false;
  let tail = null;
  let wait = null;
  let stopped = false;
  let listening = null;

  const apply = () => {
    if (stopped) return;
    const on = open && (bargeIn || (!speaking && tail === null));
    if (on === listening) return;
    listening = on;
    setListening(on);
  };
  const later = (run, ms) => {
    const timer = setTimer(() => {
      if (!stopped) run();
    }, ms);
    timer?.unref?.();
    return timer;
  };
  const openNow = () => {
    if (wait !== null) clearTimer(wait);
    wait = null;
    greeting = false;
    open = true;
    apply();
  };
  // The voice of the agent ended: its last sound is still on the line for a moment.
  const endOfSpeech = () => {
    if (tail !== null) clearTimer(tail);
    tail = later(() => {
      tail = null;
      apply();
    }, tailMs);
  };

  apply();
  // No ready signal: the caller speaks first, so the agent must listen at some point.
  wait = later(openNow, fallbackMs);

  return {
    /** The call is ready and the greeting starts now. */
    ready() {
      if (stopped || open || greeting) return;
      greeting = true;
      spoke = false;
      if (wait !== null) clearTimer(wait);
      // The greeting did not start, or never ended: listen anyway.
      wait = later(openNow, greetingMs);
    },
    /** The agent's state changed: "speaking", "listening", "thinking" or another word. */
    state(next) {
      if (stopped) return;
      const now = next === "speaking";
      if (now === speaking) return;
      speaking = now;
      if (speaking) {
        if (greeting) spoke = true;
        if (tail !== null) clearTimer(tail);
        tail = null;
        apply();
        return;
      }
      endOfSpeech();
      // The first speech after the ready signal is the greeting. When it is over, the caller may speak.
      if (greeting && spoke) openNow();
      else apply();
    },
    listening: () => listening === true,
    stop() {
      stopped = true;
      for (const timer of [tail, wait]) if (timer !== null) clearTimer(timer);
      tail = wait = null;
    },
  };
}
