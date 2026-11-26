import { createHash } from "node:crypto";
import {
  mkdirSync,
  openSync,
  fsyncSync,
  closeSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  lstatSync,
} from "node:fs";
import { z } from "zod";
import { join, isAbsolute } from "node:path";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const decline = { action: "decline" };

/** Application-owned provider callback contract. No provider receiver is
 * replaced. Preparation is journaled before allocation and never blindly
 * repeated. The provider's lifecycle acknowledgment is not cleanup proof. */
export function createSharedByor({
  directory,
  lineId,
  projectId,
  coordinator,
  media,
  now = Date.now,
}) {
  const pending = new Map();
  const filename = (id) => join(directory, `${digest(id)}.json`);
  const load = (id) => {
    const file = filename(id);
    if (!existsSync(file)) return null;
    const stat = lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      stat.uid !== process.getuid?.()
    )
      throw Error("shared_provider_journal_refused");
    return JSON.parse(readFileSync(file, "utf8"));
  };
  const save = (record) => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      stat.uid !== process.getuid?.()
    )
      throw Error("shared_provider_directory_refused");
    const file = filename(record.operationId),
      temp = `${file}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(record));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
    const parent = openSync(directory, "r");
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
    return record;
  };
  const identity = (call) => {
    if (
      !call ||
      call.line_id !== lineId ||
      call.project_id !== projectId ||
      !/^[A-Za-z0-9_:-]{1,160}$/.test(call.operation_id ?? "") ||
      !/^[A-Za-z0-9_:-]{1,160}$/.test(call.call_id ?? "")
    )
      throw Error("shared_provider_binding_refused");
    return digest(
      JSON.stringify([
        call.operation_id,
        call.call_id,
        call.line_id,
        call.project_id,
      ]),
    );
  };
  const event = (record, kind) =>
    coordinator("/line/event", {
      kind,
      eventId: `${kind}:${record.operationId}`,
      lineId,
      providerCallId: record.providerCallId,
      roomId: record.roomId,
      participantId: "shared-bridge",
      expiresAt: now() + 30_000,
    });
  const handler = {
    version: 1,
    async health() {
      return "unknown";
    },
    async prepare(call, context) {
      const fingerprint = identity(call),
        old = load(call.operation_id);
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw Error("shared_provider_conflict");
        // Do not return old bearer credentials or allocate a replacement room.
        return decline;
      }
      if (
        context.signal.aborted ||
        call.media?.audio !== true ||
        typeof call.media?.video !== "boolean" ||
        !Number.isFinite(context.remaining_ms) ||
        context.remaining_ms <= 0 ||
        !Number.isFinite(call.prepare_deadline_at) ||
        call.prepare_deadline_at <= now() ||
        !Number.isFinite(call.maximum_session_expires_at) ||
        call.maximum_session_expires_at <= now()
      )
        return decline;
      const record = save({
        operationId: call.operation_id,
        fingerprint,
        providerCallId: call.call_id,
        roomId: `shared_${digest(call.operation_id)}`,
        phase: "registered",
        settled: true,
      });
      const preparing = (async () => {
        const admitted = await event(record, "incoming");
        if (admitted.state !== "unknown_identity" || context.signal.aborted) {
          save({ ...record, phase: "declined" });
          return decline;
        }
        save({ ...record, phase: "creating", settled: false });
        let prepared;
        try {
          prepared = await media.prepare({
            roomId: record.roomId,
            agentIdentity: "shared-agent",
            bridgeIdentity: "shared-bridge",
            expiresAt: Math.min(
              call.maximum_session_expires_at,
              now() + 3_600_000,
            ),
            deadlineAt: Math.min(
              call.prepare_deadline_at,
              now() + context.remaining_ms,
            ),
            video: call.media.video,
            signal: context.signal,
          });
        } catch {
          save({ ...record, phase: "unknown", settled: false });
          return decline;
        }
        save({ ...record, phase: "ready", settled: true });
        if (
          context.signal.aborted ||
          call.prepare_deadline_at <= now() ||
          !Number.isFinite(prepared.expiresAt) ||
          prepared.expiresAt <= now() ||
          prepared.expiresAt > call.maximum_session_expires_at
        )
          return decline;
        return {
          action: "accept",
          ready: true,
          session_ref: record.roomId,
          session_expires_at: prepared.expiresAt,
          livekit_url: prepared.url,
          participant_token: prepared.token,
          remote_participant_identity: "shared-agent",
        };
      })();
      pending.set(call.operation_id, preparing);
      try {
        return await preparing;
      } finally {
        pending.delete(call.operation_id);
      }
    },
    async lifecycle(call, event, context) {
      const fingerprint = identity(call),
        record = load(call.operation_id);
      if (!record || record.fingerprint !== fingerprint)
        return { acknowledged: false };
      // No payload, transcript, or credential is recorded in the journal.
      if (context.authoritative_terminal) save({ ...record, terminal: true });
      return { acknowledged: true };
    },
    async recover(call, context) {
      const fingerprint = identity(call);
      await pending.get(call.operation_id);
      const record = load(call.operation_id);
      if (!record || record.fingerprint !== fingerprint)
        return { settled: false, cleanup: "unknown" };
      if (record.phase === "ended")
        return { settled: true, cleanup: "clean", session_ref: record.roomId };
      if (!record.settled)
        return {
          settled: false,
          cleanup: "unknown",
          session_ref: record.roomId,
        };
      if (!context.authoritative_terminal && !context.cancel_requested)
        return {
          settled: true,
          cleanup: "pending",
          session_ref: record.roomId,
        };
      try {
        if (record.phase === "ready" && !(await media.cleanup(record.roomId)))
          return {
            settled: true,
            cleanup: "unknown",
            session_ref: record.roomId,
          };
        await event(record, "cleanup_complete");
        save({ ...record, phase: "ended" });
        return { settled: true, cleanup: "clean", session_ref: record.roomId };
      } catch {
        return {
          settled: true,
          cleanup: "unknown",
          session_ref: record.roomId,
        };
      }
    },
  };
  return handler;
}

let handler;
async function configured() {
  if (handler) return handler;
  const { readPrivateJSON } =
    await import("../dist/connectors/shared/private-file.js");
  const { AccessToken, RoomServiceClient, AgentDispatchClient } =
    await import("livekit-server-sdk");
  const path = process.env.CLAWDTIME_SHARED_PROVIDER_CONFIG;
  if (!path || !isAbsolute(path))
    throw Error("shared_provider_config_required");
  const loaded = readPrivateJSON(path);
  if (loaded.problem || !loaded.value || loaded.value.enabled !== true)
    throw Error("shared_provider_standby");
  const c = z
    .object({
      enabled: z.literal(true),
      directory: z.string().refine(isAbsolute),
      coordinatorOrigin: z.url(),
      lineToken: z.string().min(32),
      lineId: z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/),
      projectId: z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/),
      livekitUrl: z.url(),
      livekitKey: z.string().min(1),
      livekitSecret: z.string().min(16),
      agentName: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
    })
    .strict()
    .parse(loaded.value);
  const origin = new URL(c.coordinatorOrigin),
    livekit = new URL(c.livekitUrl);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    livekit.protocol !== "wss:" ||
    livekit.username ||
    livekit.password ||
    livekit.pathname !== "/" ||
    livekit.search ||
    livekit.hash ||
    c.lineToken?.length < 32
  )
    throw Error("shared_provider_configuration_refused");
  const rooms = new RoomServiceClient(
    c.livekitUrl,
    c.livekitKey,
    c.livekitSecret,
  );
  const dispatch = new AgentDispatchClient(
    c.livekitUrl,
    c.livekitKey,
    c.livekitSecret,
  );
  handler = createSharedByor({
    directory: c.directory,
    lineId: c.lineId,
    projectId: c.projectId,
    coordinator: async (path, body) => {
      const result = await fetch(`${origin.origin}${path}`, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${c.lineToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(4000),
      });
      if (!result.ok) throw Error("shared_coordinator_refused");
      return result.json();
    },
    media: {
      async prepare({
        roomId,
        agentIdentity,
        bridgeIdentity,
        expiresAt,
        deadlineAt,
        signal,
        video,
      }) {
        await rooms.createRoom({
          name: roomId,
          emptyTimeout: 20,
          maxParticipants: 2,
        });
        if (signal.aborted) throw Error("shared_preparation_cancelled");
        await dispatch.createDispatch(roomId, c.agentName);
        let ready = false;
        while (!signal.aborted && Date.now() < deadlineAt) {
          const participants = await rooms.listParticipants(roomId);
          ready = participants.some(
            (p) =>
              p.identity === agentIdentity &&
              p.tracks.some((t) => t.type === 0 && !t.muted) &&
              (!video || p.tracks.some((t) => t.type === 1 && !t.muted)),
          );
          if (ready) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!ready) throw Error("shared_agent_not_ready");
        const token = new AccessToken(c.livekitKey, c.livekitSecret, {
          identity: bridgeIdentity,
          ttl: Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)),
        });
        token.addGrant({
          roomJoin: true,
          room: roomId,
          canPublish: true,
          canSubscribe: true,
        });
        return {
          url: c.livekitUrl,
          token: await token.toJwt(),
          expiresAt: expiresAt - 1000,
        };
      },
      async cleanup(roomId) {
        await rooms.deleteRoom(roomId);
        return (await rooms.listRooms([roomId])).length === 0;
      },
    },
  });
  return handler;
}
// Importing the callback module neither claims the line nor allocates a room.
export default {
  version: 1,
  health: async () => "unknown",
  prepare: async (...args) => (await configured()).prepare(...args),
  lifecycle: async (...args) => (await configured()).lifecycle(...args),
  recover: async (...args) => (await configured()).recover(...args),
};
