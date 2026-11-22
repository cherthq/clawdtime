// Explicit opt-in integration check. Creates one isolated LiveKit room and a
// synthetic caller; never claims a phone line, records media or controls a Mac.
import {
  constants,
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import {
  AccessToken,
  RoomAgentDispatch,
  RoomServiceClient,
} from "livekit-server-sdk";
// RTC defaults to verbose development logs; this diagnostic emits only codes.
process.env.NODE_ENV = "production";
const { Room, RoomEvent, VideoStream, AudioStream, TrackKind } =
  await import("@livekit/rtc-node");
import { startupError } from "./startup-diagnostics.mjs";

if (process.argv[2] !== "--env-file" || !process.argv[3]) {
  console.error(
    "Usage: node line/startup-smoke.mjs --env-file /absolute/protected.env",
  );
  process.exit(2);
}
const fd = openSync(process.argv[3], constants.O_RDONLY | constants.O_NOFOLLOW);
const stat = fstatSync(fd);
if (
  !stat.isFile() ||
  stat.uid !== process.getuid() ||
  stat.mode & 0o077 ||
  stat.size > 32768
)
  throw new Error("Protected environment required");
const configured = parseEnv(readFileSync(fd, "utf8"));
closeSync(fd);
if (
  ![
    "LIVEKIT_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "OPENAI_API_KEY",
  ].every((k) => configured[k])
)
  throw new Error("Required credential references unavailable");
process.umask(0o077);
const root = mkdtempSync(join(tmpdir(), "clawdtime-startup-"));
const id = randomUUID();
const roomName = `clawdtime-startup-${id}`;
const agentName = `startup-${id}`;
const api = new RoomServiceClient(
  configured.LIVEKIT_URL,
  configured.LIVEKIT_API_KEY,
  configured.LIVEKIT_API_SECRET,
  { failover: false, requestTimeout: 10 },
);
const reservation = createServer();
await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const healthPort = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const room = new Room();
const stages = new Set(),
  readers = [];
let child,
  created = false,
  createAttempted = false,
  frames = 0,
  audioFrames = 0,
  audibleFrames = 0;
let failed = false,
  closed = false,
  step = "worker_start";
const report = (code, detail = {}) =>
  console.log(JSON.stringify({ code, ...detail }));
// Counts/booleans only: never room, participant or track identifiers.
const rosterCounts = (participants) => {
  const tracks = participants.flatMap((p) => p.tracks);
  return {
    participants: participants.length,
    tracks: tracks.length,
    audio: tracks.filter((t) => t.type === 0).length,
    video: tracks.filter((t) => t.type === 1).length,
    unmutedAudio: tracks.filter((t) => t.type === 0 && !t.muted).length,
    unmutedVideo: tracks.filter((t) => t.type === 1 && !t.muted).length,
    missingMutedFlag: tracks.filter((t) => typeof t.muted !== "boolean").length,
  };
};
const deadline = Date.now() + 90000;
async function until(predicate, label, ms = 20000) {
  const end = Math.min(deadline, Date.now() + ms);
  while (!predicate()) {
    if (Date.now() >= end || failed || closed) throw new Error(label);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const consume = (track) => {
  const isVideo = track.kind === TrackKind.KIND_VIDEO;
  if (!isVideo && track.kind !== TrackKind.KIND_AUDIO) return;
  const reader = (
    isVideo ? new VideoStream(track) : new AudioStream(track)
  ).getReader();
  readers.push(reader);
  void (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (isVideo) frames++;
      else {
        audioFrames++;
        if (value.data.some((sample) => Math.abs(sample) > 100))
          audibleFrames++;
      }
    }
  })().catch(() => {});
};
room.on(RoomEvent.TrackSubscribed, consume);
try {
  child = spawn(
    process.execPath,
    [fileURLToPath(new URL("agent.mjs", import.meta.url)), "start"],
    {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      env: {
        ...process.env,
        ...configured,
        AGENT_NAME: agentName,
        CLAWDTIME_LINE_PORT: String(healthPort),
        CLAWDTIME_CONFIG_HOME: root,
        CLAWDTIME_DESKTOP_STATE: join(root, "state"),
        CLAWDTIME_LINE_PROJECT: root,
        CLAWDTIME_LINE_CLAWDTIME: "/usr/bin/false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.on("exit", () => {
    closed = true;
  });
  child.on("error", () => {
    failed = true;
  });
  for (const stream of [child.stdout, child.stderr])
    createInterface({ input: stream }).on("line", (line) => {
      try {
        const value = JSON.parse(line);
        if (
          value.clawdtime_line === "startup" &&
          /^[a-z_]+$/.test(value.code)
        ) {
          stages.add(value.code);
          report(value.code);
        }
        if (
          [
            "startup_failed",
            "caller_wait_ended",
            "call_ended",
            "greeting",
          ].includes(value.clawdtime_line)
        ) {
          stages.add(value.clawdtime_line);
          report(value.clawdtime_line);
          if (value.clawdtime_line === "startup_failed") failed = true;
        }
      } catch {
        /* Never retain arbitrary SDK messages. */
      }
    });
  // Registration is only a prerequisite, never media readiness.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  if (failed || closed) throw new Error("Isolated worker failed to start");
  step = "room_create";
  createAttempted = true;
  await api.createRoom({
    name: roomName,
    maxParticipants: 2,
    emptyTimeout: 90,
    departureTimeout: 2,
    metadata: JSON.stringify({ chert_call: id }),
    agents: [
      new RoomAgentDispatch({
        agentName,
        metadata: JSON.stringify({ chert_call: id }),
      }),
    ],
  });
  created = true;
  step = "warm_wait";
  await until(
    () => stages.has("caller_waiting"),
    "Agent did not enter waiting room",
  );
  step = "warm_roster_read";
  let before = await api.listParticipants(roomName);
  step = "warm_roster_check";
  report("warm_roster", {
    ...rosterCounts(before),
    mediaReady: stages.has("media_ready"),
  });
  if (!stages.has("media_ready")) throw new Error("Local media not ready");
  // Local publication ACK is not server roster propagation. Observe this
  // isolated room until both publications appear; never republish or retry an
  // external action. Extra/muted tracks or a changed publisher fail immediately.
  step = "warm_roster_settle";
  const rosterDeadline = Math.min(deadline, Date.now() + 5000);
  let publisherIdentity = before[0]?.identity;
  let rosterReads = 1;
  while (true) {
    const counts = rosterCounts(before);
    if (
      before.length > 1 ||
      counts.tracks > 2 ||
      counts.audio > 1 ||
      counts.video > 1 ||
      counts.audio + counts.video !== counts.tracks ||
      counts.unmutedAudio !== counts.audio ||
      counts.unmutedVideo !== counts.video ||
      counts.missingMutedFlag !== 0 ||
      (publisherIdentity &&
        before.length === 1 &&
        before[0].identity !== publisherIdentity)
    )
      throw new Error("Unexpected warm publication roster");
    if (before.length === 1) publisherIdentity ??= before[0].identity;
    if (before.length === 1 && counts.audio === 1 && counts.video === 1) break;
    if (failed || closed || Date.now() >= rosterDeadline)
      throw new Error("Warm roster did not settle");
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(150, rosterDeadline - Date.now())),
    );
    const remaining = rosterDeadline - Date.now();
    if (remaining <= 0 || failed || closed)
      throw new Error("Warm roster did not settle");
    let timeout;
    try {
      before = await Promise.race([
        api.listParticipants(roomName),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Warm roster read timeout")),
            remaining,
          );
        }),
      ]);
      rosterReads++;
    } finally {
      clearTimeout(timeout);
    }
  }
  report("warm_roster_settled", {
    ...rosterCounts(before),
    reads: rosterReads,
  });
  const warmTrackIds = before[0].tracks.map((t) => t.sid).sort();
  report("waiting_with_synthetic_media");
  step = "caller_connect";
  const token = new AccessToken(
    configured.LIVEKIT_API_KEY,
    configured.LIVEKIT_API_SECRET,
    { identity: `chert-bridge-${id}`, ttl: 120 },
  );
  token.addGrant({
    room: roomName,
    roomJoin: true,
    canSubscribe: true,
    canPublish: false,
  });
  await room.connect(configured.LIVEKIT_URL, await token.toJwt(), {
    autoSubscribe: true,
  });
  step = "session_video_wait";
  await until(
    () => stages.has("ready_waiting") && frames >= 3,
    "Video/session startup unavailable",
    30000,
  );
  step = "active_roster_read";
  const participants = await api.listParticipants(roomName);
  const publisher = participants.find((p) => p.identity === before[0].identity);
  step = "active_roster_check";
  report("active_roster", {
    ...rosterCounts(participants),
    samePublisher: Boolean(publisher),
  });
  if (
    !publisher ||
    JSON.stringify(publisher.tracks.map((t) => t.sid).sort()) !==
      JSON.stringify(warmTrackIds) ||
    !publisher.tracks.some((t) => t.type === 0 && !t.muted) ||
    !publisher.tracks.some((t) => t.type === 1 && !t.muted)
  )
    throw new Error("Audio and video must share the exact agent publisher");
  report("camera_frames_received", { frames, samePublisher: true });
  // Synthetic readiness only; does not assert the provider's FaceTime bridge.
  step = "synthetic_ready_mark";
  await api.updateRoomMetadata(
    roomName,
    JSON.stringify({ chert_call: id, chert_bridge_ready: true }),
  );
  step = "greeting_wait";
  await until(() => audibleFrames >= 3, "Greeting audio unavailable", 15000);
  report("greeting_audio_received", { audioFrames, audibleFrames });
  step = "caller_disconnect";
  await room.disconnect();
  step = "cleanup_wait";
  await until(
    () => stages.has("call_ended"),
    "Caller disconnect cleanup unavailable",
    10000,
  );
  report("synthetic_startup_passed");
} catch (error) {
  const workerFailed = failed;
  failed = true;
  report("synthetic_startup_failed", {
    step,
    workerFailed,
    workerExited: closed,
    deadlineReached: Date.now() >= deadline,
    frames,
    audioFrames,
    audibleFrames,
    ...startupError(error),
  });
} finally {
  for (const reader of readers) await reader.cancel().catch(() => {});
  await room.disconnect().catch(() => {});
  let removed = !createAttempted;
  if (createAttempted) {
    try {
      await api.deleteRoom(roomName);
      removed = true;
    } catch (error) {
      removed = error?.status === 404;
    }
  }
  if (child && !closed) {
    child.kill("SIGINT");
    const end = Date.now() + 10000;
    while (!closed && Date.now() < end)
      await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!removed || !closed) failed = true;
  report("cleanup", {
    roomCreated: created,
    roomRemoved: removed,
    workerExited: closed,
  });
  // Temporary root has no call receipts or media; remove only after confirmed cleanup.
  if (removed && closed) rmSync(root, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
