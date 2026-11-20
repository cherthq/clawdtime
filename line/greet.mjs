// The first words of a call, at the right moment.
// `chert dev` sets the room metadata to a JSON text with "chert_bridge_ready": true when FaceTime is ready. The
// line ends a call that hears nothing within 10 seconds of that. So the agent greets once on that signal, and
// never because the caller joined: FaceTime can still be connecting then. Without the signal, nobody greets and
// the caller speaks first.

/** True when the room metadata says that FaceTime is ready. The metadata is a JSON text. */
export function bridgeReady(metadata) {
  if (typeof metadata !== "string" || !metadata) return false;
  try {
    return JSON.parse(metadata)?.chert_bridge_ready === true;
  } catch {
    return false;
  }
}

/**
 * Calls `greet` once, when the room says that FaceTime is ready. It looks at the metadata that the room has now,
 * and at each change after that. It gives a function that stops the wait.
 * @param {{ metadata?: string, on: Function, off: Function }} room
 * @param {() => unknown} greet
 * @param {{ event?: string, onError?: (error: unknown) => void }} [options] `event` is the name of the room's
 *   metadata change event
 */
export function greetOnBridgeReady(
  room,
  greet,
  { event = "roomMetadataChanged", onError } = {},
) {
  let done = false;
  const look = (metadata) => {
    if (done || !bridgeReady(metadata)) return;
    done = true;
    room.off(event, look);
    try {
      greet();
    } catch (error) {
      onError?.(error);
    }
  };
  room.on(event, look);
  look(room.metadata);
  return () => {
    done = true;
    room.off(event, look);
  };
}
