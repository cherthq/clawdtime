// Deliberately exclude exception messages, paths, participant identities and
// SDK payloads: these can contain credentials, transcripts or account data.
const ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "AbortError",
  "TimeoutError",
  "ConnectionError",
  "RpcError",
]);
const SOURCES = [
  "agent.mjs",
  "call-end.mjs",
  "call-video.mjs",
  "job.js",
  "room.js",
  "video_source.js",
  "track.js",
  "agent_session.js",
];

export function startupError(error) {
  const error_name = ERROR_NAMES.has(error?.name) ? error.name : "UnknownError";
  const stack =
    typeof error?.stack === "string" ? error.stack.split("\n").slice(1) : [];
  for (const line of stack) {
    const match = line.match(/\/([^/():]+):(\d{1,7}):\d{1,7}\)?$/);
    if (match && SOURCES.includes(match[1]))
      return { error_name, source: `${match[1]}:${match[2]}` };
  }
  return { error_name };
}

/** Counts only. No participant IDs, room names, metadata or track names. */
export function startupRoom(room) {
  const participants = [...(room.remoteParticipants?.values() ?? [])];
  return {
    connected: room.isConnected === true,
    participants: participants.length,
    bridge_participants: participants.filter((p) =>
      p.identity?.startsWith("chert-bridge-"),
    ).length,
  };
}
