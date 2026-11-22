// The first words of a call, at the right moment.
// The line ends a call that hears nothing within 10 seconds of FaceTime being ready, and it drops what the agent
// says before that. So the agent greets once, on a signal that FaceTime is ready, and never because the caller
// joined: FaceTime can still be connecting then. Two signals say it:
//  - The line's own audio track in the room. The line publishes the caller's voice as a track with a fixed name
//    only when FaceTime is active and the agent's audio is on. It is there at once.
//  - The room's ready mark: `chert dev` sets the room metadata to a JSON text with "chert_bridge_ready": true.
//    The same fact, about two seconds later, because it travels through two polls.
// The agent greets on the first of the two. Without either, nobody greets and the caller speaks first.

/** The name of the track that carries the caller's voice from the line. */
export const LINE_AUDIO = "facetime-remote-audio";

/** True when the room metadata says that FaceTime is ready. The metadata is a JSON text. */
export function bridgeReady(metadata) {
  if (typeof metadata !== "string" || !metadata) return false;
  try {
    return JSON.parse(metadata)?.chert_bridge_ready === true;
  } catch {
    return false;
  }
}

/** True when a participant of the room has published the line's audio track. */
export function lineAudioIn(room, name = LINE_AUDIO) {
  try {
    for (const participant of room.remoteParticipants?.values?.() ?? [])
      for (const publication of participant.trackPublications?.values?.() ?? [])
        if (publication?.name === name) return true;
  } catch {
    /* A room that is closing has nothing to look at. */
  }
  return false;
}

/**
 * Calls `greet` once, on the first signal that FaceTime is ready. It looks at what the room has now, and at each
 * change after that. It gives a function that stops the wait.
 * @param {{ metadata?: string, on: Function, off: Function, remoteParticipants?: Map<string, unknown> }} room
 * @param {(signal: "track" | "mark") => unknown} greet
 * @param {{
 *   event?: string, trackEvents?: string[], trackName?: string,
 *   onSignal?: (kind: "track" | "mark") => void, onError?: (error: unknown) => void,
 * }} [options] `event` is the name of the room's metadata change event. `trackEvents` are the names of the
 *   events for a track that a participant published or that this agent subscribed to; without them only the
 *   mark counts. `onSignal` hears each signal once, also the one that comes after the greeting.
 */
export function greetOnBridgeReady(
  room,
  greet,
  {
    event = "roomMetadataChanged",
    trackEvents = [],
    trackName = LINE_AUDIO,
    onSignal,
    onError,
  } = {},
) {
  let greeted = false,
    stopped = false;
  const seen = new Set();
  const detach = () => {
    room.off(event, mark);
    for (const name of trackEvents) room.off(name, track);
  };
  const signal = (kind) => {
    if (stopped || seen.has(kind)) return;
    seen.add(kind);
    try {
      onSignal?.(kind);
    } catch {
      /* A record that fails must not stop the greeting. */
    }
    if (!greeted) {
      greeted = true;
      try {
        greet(kind);
      } catch (error) {
        onError?.(error);
      }
    }
    // After the greeting it listens on only to record the second signal, and only when somebody records it.
    if (!onSignal || seen.size >= (trackEvents.length ? 2 : 1)) detach();
  };
  function mark(metadata) {
    if (bridgeReady(metadata)) signal("mark");
  }
  // The events give the publication in different places: it is the argument that has the track's name.
  function track(...parts) {
    if (parts.some((part) => part?.name === trackName)) signal("track");
  }
  room.on(event, mark);
  for (const name of trackEvents) room.on(name, track);
  if (trackEvents.length && lineAudioIn(room, trackName)) signal("track");
  mark(room.metadata);
  return () => {
    stopped = true;
    detach();
  };
}
