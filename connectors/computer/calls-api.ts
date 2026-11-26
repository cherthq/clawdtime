/**
 * Computer use: the call side of the reach over the public Calls API of Chert
 * (`chert-calls-api`). It works with any build of the chert command, because
 * it needs no part of it: only the project API key, the line of the project,
 * the owner's number and the LiveKit settings of the line agent.
 *
 * One call for one question, in this order:
 *
 * 1. A new LiveKit room is made for the question, and the line agent is sent
 *    into it with the job metadata `{kind: "reach", requestId, questionId,
 *    question, answerOrigin}`. The metadata holds no key and no token. The
 *    line agent reads its capability for this one call from an owner-only
 *    file, `computer/reach-calls/<questionId>.json`, and joins.
 * 2. The line agent says that it is ready, with its identity. LiveKit must
 *    show it alone in the room with one audio track that is not muted.
 * 3. A bridge token is made for that one room, with its own identity, and the
 *    call is placed: `POST /calls`, `mode: customer_managed`, the owner's
 *    number, the line, audio always and video only when the line has it. Its
 *    idempotency key belongs to the question. A request that got no answer at
 *    all is sent again, at most twice, with the same body and the same key,
 *    so it can never place a second call. Any answer ends the retries.
 * 4. The call and its events are read about once a second. On `bridge_ready`
 *    the room metadata gets `chert_bridge_ready: true`, and the line agent
 *    greets with the question.
 * 5. The owner's words come from the line agent to `POST
 *    /computer/reach/call/<questionId>` of the desktop service, which hands
 *    them to the reach as an answer said on a call. Stop on the call stops the
 *    computer task. Once the question is answered, the call ends after a
 *    short goodbye: `POST /calls/{id}/end` with its own idempotency key. A
 *    call also ends after a bounded time.
 * 6. The outcome goes to the reach: answered (the owner picked up), no
 *    answer, failed (no call reached the owner), or unknown. The reach then
 *    texts exactly as with any other call side.
 *
 * Rules that are code here: one call for each question, also after a
 * restart, never a redial; a call whose outcome is not known stays unknown
 * and is never placed again; nothing is placed without a record of it first.
 * The record (`computer/reach-calls.json`) holds ids, states and fixed
 * codes, never a number, a key, a token or a word of the question.
 */
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { Hono } from "hono";
import { z } from "zod";
import { DomainError, equal } from "../../src/storage/security.js";
import { readChertKey, readOwner } from "../shared/owner.js";
import {
  readPrivateBytes,
  readPrivateJSON,
  writePrivateJSON,
} from "../shared/private-file.js";
import { computerDirectory } from "./journal.js";
import {
  LiveKitError,
  LiveKitRooms,
  liveKitToken,
  type LiveKitPort,
} from "./livekit.js";
import type { CallPhase, ReachAsk, ReachCallPort } from "./reach.js";

export const callsProvider = "chert-calls-api" as const;
/** The documented address of the Calls API. CHERT_CALLS_API_BASE changes it. */
export const callsApiBase = "https://facetime.trychert.com/api/v1";

/** What `clawdtime connect` keeps for this path: the line and where its agent is. */
export const callsFile = (root: string) => join(root, "calls.json");
/** The capability of each call for the line agent, one owner-only file each. */
export const reachCallsFolder = (root: string) =>
  join(computerDirectory(root), "reach-calls");
const recordFile = (root: string) =>
  join(computerDirectory(root), "reach-calls.json");

/** Times of one call. Exported for the docs and the tests. */
export const callTimes = {
  /** The line agent must be ready in the room within this time, or no call is placed. */
  agentMs: 25_000,
  /** A call that rings this long without FaceTime being ready is ended. */
  ringMs: 90_000,
  /** A call that is ready ends at the latest after this time. */
  liveMs: 240_000,
  /** After the answer, the line agent says goodbye in this time. Then the call ends. */
  goodbyeMs: 10_000,
  /** After the end request, the outcome is read for this long. Then it stays as it is. */
  endMs: 60_000,
  /** Reads of the call that fail for this long end the call. */
  blindMs: 30_000,
  pollMs: 1_000,
  /** The life of the bridge token and of the capability of the line agent. */
  tokenSeconds: 900,
} as const;

const uuid = z.string().uuid();
const questionId = z.string().regex(/^[a-f0-9]{24}$/);
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const code = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "unknown";

const callsSchema = z
  .object({
    version: z.literal(1),
    provider: z.literal(callsProvider),
    projectId: uuid,
    lineId: uuid,
    /** The line takes outbound video. Without it the call is FaceTime Audio. */
    video: z.boolean(),
    /** The folder of the line agent, with its private `.env.local`. */
    lineDirectory: z.string().startsWith("/").max(4096),
  })
  .strict();
export type CallsRecord = z.infer<typeof callsSchema>;

/** What `clawdtime connect` kept for this path, or null, and the problem of the file. */
export function readCallsRecord(root: string): {
  record: CallsRecord | null;
  problem: string | null;
} {
  const read = readPrivateJSON(callsFile(root));
  if (read.problem || read.value === null)
    return { record: null, problem: read.problem };
  const parsed = callsSchema.safeParse(read.value);
  return parsed.success
    ? { record: parsed.data, problem: null }
    : {
        record: null,
        problem: `${callsFile(root)} is not valid, so it is not used and not changed.`,
      };
}
export function writeCallsRecord(root: string, record: CallsRecord) {
  writePrivateJSON(callsFile(root), callsSchema.parse(record));
}

/** Everything one call needs. Never printed. */
export interface CallsSettings {
  base: string;
  apiKey: string;
  projectId: string;
  lineId: string;
  video: boolean;
  owner: string;
  liveKit: { url: string; apiKey: string; apiSecret: string };
  agentName: string;
}

const placeholder = (value: string | undefined) =>
  !value?.trim() || /^(wss:\/\/)?YOUR_/.test(value.trim());

/** The LiveKit settings of the line agent, from its owner-only `.env.local`. */
export function lineLiveKit(lineDirectory: string):
  | { liveKit: CallsSettings["liveKit"]; agentName: string }
  | {
      missing:
        | "livekit_settings"
        | "model_key"
        | "agent_name"
        | "line_settings_unreadable";
    } {
  const read = readPrivateBytes(join(lineDirectory, ".env.local"), {
    folder: "owner-writable",
  });
  if (read.problem) return { missing: "line_settings_unreadable" };
  if (!read.bytes) return { missing: "livekit_settings" };
  const values = parseEnv(read.bytes.toString("utf8"));
  const url = values.LIVEKIT_URL?.trim() ?? "";
  if (
    !/^wss:\/\/[^\s/]+/.test(url) ||
    placeholder(url) ||
    placeholder(values.LIVEKIT_API_KEY) ||
    placeholder(values.LIVEKIT_API_SECRET)
  )
    return { missing: "livekit_settings" };
  // The line agent speaks with this key: without it nobody talks on the call.
  if (placeholder(values.OPENAI_API_KEY)) return { missing: "model_key" };
  const agentName = values.AGENT_NAME?.trim() || "clawdtime";
  if (!identifier.safeParse(agentName).success)
    return { missing: "agent_name" };
  return {
    liveKit: {
      url,
      apiKey: values.LIVEKIT_API_KEY!.trim(),
      apiSecret: values.LIVEKIT_API_SECRET!.trim(),
    },
    agentName,
  };
}

/**
 * The settings of this path, or the first piece that is missing, as a fixed
 * code. A variable of the environment wins over a stored value, as for texts.
 */
export function callsSettings(
  env: Record<string, string | undefined>,
  root: string,
): { settings: CallsSettings } | { missing: string } {
  const stored = readCallsRecord(root);
  if (stored.problem) return { missing: "calls_file_unreadable" };
  const record = stored.record;
  // A stored key is used only with its own project, never with another one.
  const envKey = env.CHERT_API_KEY?.trim() ?? "";
  const envProject = env.CHERT_PROJECT_ID?.trim() ?? "";
  const key = envKey ? null : readChertKey(root).key;
  const pair =
    key && (!envProject || envProject === key.projectId) ? key : null;
  const apiKey = envKey || pair?.apiKey || "";
  const projectId = envProject || pair?.projectId || "";
  if (!apiKey || !uuid.safeParse(projectId).success)
    return { missing: "project_api_key" };
  if (record && record.projectId !== projectId)
    return { missing: "line_of_this_project" };
  const lineId = env.CHERT_LINE_ID?.trim() || record?.lineId || "";
  if (!uuid.safeParse(lineId).success) return { missing: "line_id" };
  const { owner, problem } = readOwner(root);
  // An owner.json that cannot be read places no call, and says so.
  if (problem) return { missing: "owner_unreadable" };
  if (!owner) return { missing: "owner_number" };
  if (owner.consent?.answer !== "yes") return { missing: "consent" };
  const lineDirectory =
    env.CLAWDTIME_LINE_DIRECTORY?.trim() || record?.lineDirectory || "";
  if (!lineDirectory.startsWith("/")) return { missing: "line_directory" };
  const line = lineLiveKit(lineDirectory);
  if ("missing" in line) return { missing: line.missing };
  const base = (env.CHERT_CALLS_API_BASE?.trim() || callsApiBase).replace(
    /\/+$/,
    "",
  );
  try {
    const parsed = new URL(base);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password)
      return { missing: "calls_api_base" };
  } catch {
    return { missing: "calls_api_base" };
  }
  return {
    settings: {
      base,
      apiKey,
      projectId,
      lineId,
      video: record?.lineId === lineId ? record.video : false,
      owner: owner.phone,
      liveKit: line.liveKit,
      agentName: line.agentName,
    },
  };
}

const resultSchema = z.enum(["answered", "not_answered", "failed", "unknown"]);
type Result = z.infer<typeof resultSchema>;
const entrySchema = z
  .object({
    id: questionId,
    requestId: z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/),
    at: z.number().int().nonnegative(),
    state: z.enum(["preparing", "placing", "allocated", "over"]),
    callId: uuid.optional(),
    connected: z.boolean(),
    result: resultSchema.optional(),
    reason: z
      .string()
      .regex(/^[a-z0-9_]{1,60}$/)
      .optional(),
    /** A call of an earlier run of the service that is still to be cleaned up: its room, and its call when it has an id. */
    cleanup: z.literal(true).optional(),
  })
  .strict();
type Entry = z.infer<typeof entrySchema>;
const recordSchema = z
  .object({ version: z.literal(1), items: z.array(entrySchema).max(50) })
  .strict();

/** A request to the Calls API that got no answer at all. */
class NoAnswer extends Error {}

interface Turn {
  text: string;
  reply: Promise<{ message: string; done: boolean }>;
}
interface Flight {
  entry: Entry;
  spoken: string;
  token: string;
  room: string;
  bridge: string;
  /** The line agent's own identity in the room, once it said it is ready. */
  agent?: string;
  /** Taken back before the request went out. */
  aborted: boolean;
  /** Why the call is to end, once it is to end. */
  endFor?: string;
  endSent: boolean;
  /** The question was settled on this call: an answer or a stop. */
  done: boolean;
  doneAt?: number;
  turns: Map<string, Turn>;
  work: Promise<void>;
}

/** What the reply of the desktop service holds for the line agent. */
export interface ReachLineReply {
  open: boolean;
  question: string;
  callerIdentity: string;
  roomName: string;
  connected: boolean;
  done: boolean;
  message?: string;
}

export interface ChertReachCallsOptions {
  root: string;
  env: Record<string, string | undefined>;
  /** The address of this desktop service: the line agent posts the owner's words here. */
  origin: string;
  /** The owner's words said on the call, for the question. `done` when it no longer waits. */
  answer(
    questionId: string,
    words: string,
  ): Promise<{ message: string; done: boolean }>;
  /** Stop said on the call: it stops the computer task. */
  stop(questionId: string): string;
  /** The line is in another call now. */
  liveCall?: () => boolean;
  request?: typeof fetch;
  liveKit?: (settings: CallsSettings["liveKit"]) => LiveKitPort;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Settings for a test, in place of the files. */
  settings?: () => ReturnType<typeof callsSettings>;
}

/** The call side of the reach over the Calls API. See the top of this file. */
export class ChertReachCalls implements ReachCallPort {
  private readonly flights = new Map<string, Flight>();
  private record: z.infer<typeof recordSchema> | null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly request: typeof fetch;
  /** The end of the calls that were on the line when the service stopped. */
  readonly restored: Promise<void>;

  constructor(private readonly options: ChertReachCallsOptions) {
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms).unref?.();
        }));
    this.request = options.request ?? fetch;
    this.record = this.load();
    // A call that was on its way when the service stopped has an unknown
    // outcome. It is kept so, and never placed again. Nobody follows it any
    // more, so it is marked to be cleaned up: its room is deleted, which takes
    // the line agent out of the call, and a call that Chert had allocated is
    // ended. A call that was being placed has no id to end. The mark stays
    // until that is done, so a later start does what this one could not.
    if (this.record) {
      let changed = false;
      for (const entry of this.record.items)
        if (entry.state !== "over") {
          entry.state = "over";
          entry.result = entry.connected ? "answered" : "unknown";
          entry.reason = "service_restarted";
          entry.cleanup = true;
          changed = true;
        }
      if (changed) this.save();
      for (const entry of this.record.items) this.dropCapability(entry.id);
    }
    this.restored = this.endOrphans();
  }

  private async endOrphans() {
    const orphans = this.record?.items.filter((entry) => entry.cleanup) ?? [];
    if (!orphans.length) return;
    const found = this.settings();
    if ("missing" in found) return;
    const liveKit = (
      this.options.liveKit ??
      ((keys) => new LiveKitRooms(keys, this.request, this.now))
    )(found.settings.liveKit);
    for (const entry of orphans) {
      // The end has its own key, so a second send ends nothing new. Any
      // answer but an error of the server settles it: a refusal says that
      // the call is over or not there.
      const ended = entry.callId
        ? await this.effect(
            found.settings,
            `/calls/${entry.callId}/end`,
            JSON.stringify({ reason: "ClawdTime reach call ended" }),
            `clawdtime-reach-end-${entry.id}`,
          ).then(
            (answer) => answer.status < 500,
            () => false,
          )
        : true;
      // A room that is gone already counts as deleted.
      const deleted = await liveKit
        .deleteRoom(`clawdtime-reach-${entry.id}`)
        .then(
          () => true,
          (error: unknown) =>
            error instanceof LiveKitError && error.status === 404,
        );
      if (ended && deleted) {
        delete entry.cleanup;
        this.save();
      }
    }
  }

  private load() {
    const read = readPrivateJSON(recordFile(this.options.root));
    if (read.problem) return null;
    if (read.value === null) return { version: 1 as const, items: [] };
    const parsed = recordSchema.safeParse(read.value);
    return parsed.success ? parsed.data : null;
  }
  private save(): boolean {
    if (!this.record) return false;
    if (this.record.items.length > 50)
      this.record.items.splice(0, this.record.items.length - 50);
    try {
      writePrivateJSON(recordFile(this.options.root), this.record);
      return true;
    } catch {
      return false;
    }
  }
  private settings() {
    try {
      return (
        this.options.settings?.() ??
        callsSettings(this.options.env, this.options.root)
      );
    } catch {
      return { missing: "settings_unreadable" };
    }
  }
  private busy() {
    return [...this.flights.values()].some((f) => f.entry.state !== "over");
  }

  readiness() {
    if (!this.record)
      return { ready: false, reason: "calls_api_record_unreadable" };
    const found = this.settings();
    if ("missing" in found)
      return { ready: false, reason: `calls_api_missing:${found.missing}` };
    if (this.busy() || this.options.liveCall?.())
      return { ready: false, reason: "line_in_a_call" };
    return { ready: true, reason: "ready_chert_calls_api" };
  }

  place(ask: ReachAsk): { id: string } | { refused: string } {
    if (!questionId.safeParse(ask.key).success)
      return { refused: "question_id_invalid" };
    if (!this.record) return { refused: "calls_api_record_unreadable" };
    // One call for one question, whatever came of it, also after a restart.
    if (
      this.flights.has(ask.key) ||
      this.record.items.some((entry) => entry.id === ask.key)
    )
      return { refused: "call_already_placed" };
    const found = this.settings();
    if ("missing" in found)
      return { refused: `calls_api_missing:${found.missing}` };
    if (this.busy() || this.options.liveCall?.())
      return { refused: "line_in_a_call" };
    const entry: Entry = {
      id: ask.key,
      requestId: ask.requestId,
      at: this.now(),
      state: "preparing",
      connected: false,
    };
    this.record.items.push(entry);
    // Nothing goes out without a record of it first.
    if (!this.save()) {
      this.record.items.pop();
      return { refused: "calls_api_record_unwritable" };
    }
    const flight: Flight = {
      entry,
      spoken: ask.spoken,
      token: randomBytes(32).toString("base64url"),
      room: `clawdtime-reach-${ask.key}`,
      bridge: `clawdtime-bridge-${ask.key}`,
      aborted: false,
      endSent: false,
      done: false,
      turns: new Map(),
      work: Promise.resolve(),
    };
    this.flights.set(ask.key, flight);
    flight.work = this.run(flight, found.settings).catch(() => {
      // Before the request went out nothing reached the owner.
      this.finish(
        flight,
        flight.entry.state === "preparing"
          ? "failed"
          : flight.entry.connected
            ? "answered"
            : "unknown",
        "call_path_error",
      );
    });
    return { id: ask.key };
  }

  /** The work of one call, for a test that waits for its end. */
  settled(id: string): Promise<void> {
    return this.flights.get(id)?.work ?? Promise.resolve();
  }

  phase(id: string): CallPhase {
    const entry =
      this.flights.get(id)?.entry ??
      this.record?.items.find((item) => item.id === id);
    if (!entry)
      return { phase: "over", result: "unknown", reason: "call_not_known" };
    switch (entry.state) {
      case "preparing":
        return { phase: "unsent", reason: "preparing" };
      case "placing":
        return { phase: "live", connected: false };
      case "allocated":
        return { phase: "live", connected: entry.connected };
      default:
        return {
          phase: "over",
          result: entry.result ?? "unknown",
          ...(entry.reason ? { reason: entry.reason } : {}),
        };
    }
  }

  /** Takes back a call before its request went out. True when nothing went out. */
  cancel(id: string): boolean {
    const flight = this.flights.get(id);
    if (!flight || flight.entry.state !== "preparing") return false;
    flight.aborted = true;
    return true;
  }

  /** Ends a call that is on its way or on the line. */
  end(id: string): void {
    const flight = this.flights.get(id);
    if (!flight || flight.entry.state === "over") return;
    if (flight.entry.state === "preparing") flight.aborted = true;
    flight.endFor ??= "question_gone";
  }

  private update(flight: Flight, change: Partial<Entry>) {
    Object.assign(flight.entry, change);
    this.save();
  }
  private finish(flight: Flight, result: Result, reason: string) {
    if (flight.entry.state === "over") return;
    this.update(flight, { state: "over", result, reason: code(reason) });
    this.dropCapability(flight.entry.id);
  }
  private dropCapability(id: string) {
    try {
      unlinkSync(join(reachCallsFolder(this.options.root), `${id}.json`));
    } catch {
      // It was not there.
    }
  }

  /** One request to the Calls API. A response of any status is an answer; none is `NoAnswer`. */
  private async chert(
    settings: CallsSettings,
    method: "GET" | "POST",
    path: string,
    body?: string,
    idempotencyKey?: string,
  ): Promise<{ status: number; value: Record<string, unknown> }> {
    let response: Response;
    try {
      response = await this.request(`${settings.base}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          authorization: `Bearer ${settings.apiKey}`,
          "X-Chert-Project-Id": settings.projectId,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        ...(body !== undefined ? { body } : {}),
      });
    } catch {
      throw new NoAnswer();
    }
    let value: Record<string, unknown> = {};
    try {
      const text = await response.text();
      const parsed: unknown =
        text && text.length <= 1024 * 1024 ? JSON.parse(text) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        value = parsed as Record<string, unknown>;
    } catch {
      value = {};
    }
    return { status: response.status, value };
  }

  /**
   * Sends one effect, again only when no answer came, with the same body and
   * key. `lost` says that an earlier send got no answer: it may have taken
   * effect, whatever the last answer says.
   */
  private async effect(
    settings: CallsSettings,
    path: string,
    body: string,
    idempotencyKey: string,
  ) {
    for (let attempt = 0; ; attempt++) {
      try {
        const answer = await this.chert(
          settings,
          "POST",
          path,
          body,
          idempotencyKey,
        );
        return { ...answer, lost: attempt > 0 };
      } catch (error) {
        if (!(error instanceof NoAnswer) || attempt >= 2) throw error;
        await this.sleep(1000 * (attempt + 1));
      }
    }
  }

  private async run(flight: Flight, settings: CallsSettings) {
    const id = flight.entry.id;
    const liveKit = (
      this.options.liveKit ??
      ((keys) => new LiveKitRooms(keys, this.request, this.now))
    )(settings.liveKit);
    const expiresAt = this.now() + callTimes.tokenSeconds * 1000;
    let roomMade = false;
    const stopBeforeCall = async (reason: string) => {
      if (roomMade) await liveKit.deleteRoom(flight.room).catch(() => {});
      this.finish(flight, "failed", reason);
    };
    try {
      // The capability of the line agent for this one call, for its owner only.
      writePrivateJSON(
        join(reachCallsFolder(this.options.root), `${id}.json`),
        {
          version: 1,
          questionId: id,
          token: flight.token,
          origin: this.options.origin,
          roomName: flight.room,
          expiresAt,
        },
      );
    } catch {
      return this.finish(flight, "failed", "capability_unwritable");
    }
    if (flight.aborted) return stopBeforeCall(flight.endFor ?? "taken_back");
    try {
      await liveKit.createRoom(flight.room, {
        emptyTimeout: 120,
        departureTimeout: 5,
        maxParticipants: 2,
        metadata: JSON.stringify({ clawdtime_reach: id }),
      });
      roomMade = true;
      if (flight.aborted) return stopBeforeCall(flight.endFor ?? "taken_back");
      await liveKit.dispatch(
        flight.room,
        settings.agentName,
        JSON.stringify({
          kind: "reach",
          requestId: flight.entry.requestId,
          questionId: id,
          // The line agent says the question that the desktop service gives
          // it with its capability. The copy in LiveKit has no long numbers.
          question: flight.spoken.replace(/\d(?:[\s().-]*\d){5,}/g, "[number]"),
          answerOrigin: this.options.origin,
        }),
      );
    } catch {
      roomMade = true;
      return stopBeforeCall("room_or_dispatch_failed");
    }
    // The line agent joins, publishes its audio and says that it is ready.
    const agentBy = this.now() + callTimes.agentMs;
    while (!flight.agent) {
      if (flight.aborted) return stopBeforeCall(flight.endFor ?? "taken_back");
      if (this.now() >= agentBy) return stopBeforeCall("agent_not_ready");
      await this.sleep(250);
    }
    try {
      const rows = await liveKit.participants(flight.room);
      const agent = rows[0];
      const audio =
        agent?.tracks.filter((track) => track.type === "audio") ?? [];
      const video =
        agent?.tracks.filter((track) => track.type === "video") ?? [];
      if (
        rows.length !== 1 ||
        agent!.identity !== flight.agent ||
        audio.length !== 1 ||
        audio[0]!.muted ||
        video.length > 1
      )
        return stopBeforeCall("agent_media_not_ready");
    } catch {
      return stopBeforeCall("agent_media_unreadable");
    }
    const bridgeToken = liveKitToken({
      apiKey: settings.liveKit.apiKey,
      apiSecret: settings.liveKit.apiSecret,
      identity: flight.bridge,
      grant: {
        roomJoin: true,
        room: flight.room,
        canPublish: true,
        canSubscribe: true,
        canPublishData: false,
      },
      ttlSeconds: callTimes.tokenSeconds,
      now: this.now(),
    });
    const body = JSON.stringify({
      direction: "outbound",
      mode: "customer_managed",
      line_id: settings.lineId,
      destination: settings.owner,
      destination_type: "phone",
      media: { audio: true, video: settings.video },
      livekit_url: settings.liveKit.url,
      participant_token: bridgeToken,
      remote_participant_identity: flight.agent,
    });
    // The last moment to take it back. From here the request may go out.
    if (flight.aborted) return stopBeforeCall(flight.endFor ?? "taken_back");
    this.update(flight, { state: "placing" });
    let placed: {
      status: number;
      value: Record<string, unknown>;
      lost: boolean;
    };
    try {
      placed = await this.effect(
        settings,
        "/calls",
        body,
        `clawdtime-reach-${id}`,
      );
    } catch {
      // No answer to three sends of the same request: a call may exist.
      await liveKit.deleteRoom(flight.room).catch(() => {});
      return this.finish(flight, "unknown", "call_request_lost");
    }
    const data = (placed.value.data ?? {}) as Record<string, unknown>;
    if (placed.status === 201 || placed.status === 200) {
      const callId = uuid.safeParse(data.id);
      if (!callId.success) {
        await liveKit.deleteRoom(flight.room).catch(() => {});
        return this.finish(flight, "unknown", "call_response_invalid");
      }
      this.update(flight, { state: "allocated", callId: callId.data });
    } else if (placed.status >= 400 && placed.status < 500) {
      // A refusal: no call was placed, unless an earlier send got no answer.
      await liveKit.deleteRoom(flight.room).catch(() => {});
      return placed.lost
        ? this.finish(
            flight,
            "unknown",
            `call_refused_after_loss_${placed.status}`,
          )
        : this.finish(flight, "failed", `call_refused_${placed.status}`);
    } else {
      // A wait in a queue that this path never asks for, or an error of the
      // server: whether a call exists is not known.
      await liveKit.deleteRoom(flight.room).catch(() => {});
      return this.finish(
        flight,
        placed.status === 202 && data.queued === true ? "failed" : "unknown",
        placed.status === 202 && data.queued === true
          ? "line_busy"
          : `call_response_${placed.status}`,
      );
    }
    await this.follow(flight, settings, liveKit);
  }

  /** Reads the call until it ends, and ends it when it is time. */
  private async follow(
    flight: Flight,
    settings: CallsSettings,
    liveKit: LiveKitPort,
  ) {
    const callId = flight.entry.callId!;
    const allocatedAt = this.now();
    let readyAt: number | null = null;
    let lastRead = this.now();
    let endedAt: number | null = null;
    let polls = 0;
    let terminalReason = "";
    let terminalDetail = "";
    const endCall = async (why: string) => {
      flight.endFor ??= why;
      if (flight.endSent) return;
      flight.endSent = true;
      endedAt = this.now();
      try {
        await this.effect(
          settings,
          `/calls/${callId}/end`,
          JSON.stringify({ reason: "ClawdTime reach call ended" }),
          `clawdtime-reach-end-${flight.entry.id}`,
        );
      } catch {
        // The outcome is read on: the call may end by itself.
      }
    };
    for (;;) {
      const now = this.now();
      // When the call is to end.
      if (flight.endFor) await endCall(flight.endFor);
      else if (
        flight.done &&
        now - (flight.doneAt ?? now) >= callTimes.goodbyeMs
      )
        await endCall("answered");
      else if (readyAt === null && now - allocatedAt >= callTimes.ringMs)
        await endCall("not_answered_in_time");
      else if (readyAt !== null && now - readyAt >= callTimes.liveMs)
        await endCall("time_limit");
      else if (now - lastRead >= callTimes.blindMs)
        await endCall("call_unreadable");

      let types: Set<string> | null = null;
      try {
        const events = await this.chert(
          settings,
          "GET",
          `/calls/${callId}/events`,
        );
        if (events.status === 200) {
          const data = (events.value.data ?? {}) as { events?: unknown };
          const rows = Array.isArray(data.events) ? data.events : [];
          types = new Set(
            rows
              .slice(0, 10_000)
              .filter(
                (row) =>
                  row &&
                  typeof row === "object" &&
                  (row as { source?: unknown }).source === "worker" &&
                  typeof (row as { type?: unknown }).type === "string",
              )
              .map((row) => (row as { type: string }).type),
          );
          lastRead = this.now();
        }
      } catch {
        types = null;
      }
      polls++;
      let terminal =
        !!types &&
        ["ended", "failed", "rejected", "cleanup_complete"].some((type) =>
          types!.has(type),
        );
      if (types?.has("bridge_ready") && readyAt === null) {
        readyAt = this.now();
        this.update(flight, { connected: true });
        // The line agent greets on this mark: FaceTime is ready.
        for (let attempt = 0; attempt < 2; attempt++)
          try {
            await liveKit.setMetadata(
              flight.room,
              JSON.stringify({
                chert_bridge_ready: true,
                clawdtime_reach: flight.entry.id,
              }),
            );
            break;
          } catch {
            // Once more; the line's own audio track is the other signal.
          }
      }
      if (terminal || polls % 5 === 0) {
        try {
          const call = await this.chert(settings, "GET", `/calls/${callId}`);
          const data = (call.value.data ?? {}) as Record<string, unknown>;
          if (typeof data.terminal_reason === "string")
            terminalReason = data.terminal_reason;
          if (typeof data.terminal_detail === "string")
            terminalDetail = data.terminal_detail.slice(0, 200);
          if (
            typeof data.status === "string" &&
            [
              "ended",
              "failed",
              "rejected",
              "completed",
              "canceled",
              "cancelled",
            ].includes(data.status)
          )
            terminal = true;
        } catch {
          // The events are read again.
        }
      }
      if (terminal) {
        await liveKit.deleteRoom(flight.room).catch(() => {});
        if (flight.entry.connected)
          return this.finish(flight, "answered", "call_ended");
        // The code of the line can be the reason, or the detail of a reason
        // that says only "unknown".
        const why =
          [terminalReason, terminalDetail]
            .map((value) => /^[a-z][a-z0-9_]{1,59}/.exec(value)?.[0] ?? "")
            .find((value) => value && value !== "unknown") ?? "";
        if (
          [terminalReason, terminalDetail].some((value) =>
            value.includes("outbound_not_answered"),
          ) ||
          flight.endFor === "not_answered_in_time"
        )
          return this.finish(
            flight,
            "not_answered",
            why || "not_answered_in_time",
          );
        return this.finish(flight, "failed", why || "call_ended");
      }
      if (endedAt !== null && this.now() - endedAt >= callTimes.endMs) {
        await liveKit.deleteRoom(flight.room).catch(() => {});
        return this.finish(
          flight,
          flight.entry.connected ? "answered" : "unknown",
          "call_end_unconfirmed",
        );
      }
      await this.sleep(callTimes.pollMs);
    }
  }

  private reply(flight: Flight, message?: string): ReachLineReply {
    return {
      open: flight.entry.state !== "over" && !flight.endSent && !flight.aborted,
      question: flight.spoken,
      callerIdentity: flight.bridge,
      roomName: flight.room,
      connected: flight.entry.connected,
      done: flight.done,
      ...(message ? { message } : {}),
    };
  }

  /**
   * One command of the line agent for its call, with the capability of that
   * call. `prepared` says its identity, `status` reads the call, `answer`
   * hands the owner's words to the reach, `stop` stops the computer task,
   * `close` says that the agent left.
   */
  async lineCommand(
    id: string,
    credential: string,
    raw: unknown,
  ): Promise<ReachLineReply> {
    const flight = this.flights.get(id);
    if (!flight || !credential || !equal(credential, flight.token))
      throw new DomainError(403, "Exact reach call capability required.");
    const command = z
      .object({
        action: z.enum(["prepared", "status", "answer", "stop", "close"]),
        roomName: identifier.optional(),
        agentIdentity: identifier.optional(),
        turnId: identifier.optional(),
        text: z.string().min(1).max(2000).optional(),
      })
      .strict()
      .parse(raw);
    if (command.action === "close") {
      // The agent left: nobody speaks on the call any more.
      if (flight.entry.state === "preparing") flight.aborted = true;
      flight.endFor ??= "agent_left";
      return this.reply(flight);
    }
    if (!this.reply(flight).open)
      throw new DomainError(403, "This reach call has ended.");
    if (command.action === "prepared") {
      if (
        command.roomName !== flight.room ||
        !command.agentIdentity ||
        command.agentIdentity === flight.bridge ||
        (flight.agent && flight.agent !== command.agentIdentity)
      )
        throw new DomainError(409, "The room or the agent differs.");
      flight.agent = command.agentIdentity;
      return this.reply(flight);
    }
    if (command.action === "status") return this.reply(flight);
    // The owner speaks only once FaceTime is ready.
    if (!flight.entry.connected)
      throw new DomainError(409, "The call is not ready.");
    if (command.action === "stop") {
      const message = this.options.stop(id);
      flight.done = true;
      flight.doneAt ??= this.now();
      return this.reply(flight, message);
    }
    if (!command.turnId || !command.text)
      throw new DomainError(400, "A turn and its words are required.");
    const prior = flight.turns.get(command.turnId);
    if (prior) {
      if (prior.text !== command.text)
        throw new DomainError(409, "This turn differs from its first words.");
      return this.reply(flight, (await prior.reply).message);
    }
    if (flight.done)
      return this.reply(flight, "That question has its answer already.");
    if (flight.turns.size >= 64)
      throw new DomainError(409, "Too many turns on this call.");
    const reply = this.options.answer(id, command.text).catch(() => ({
      message:
        "The answer may have reached the Mac, but its outcome is unknown.",
      done: true,
    }));
    flight.turns.set(command.turnId, { text: command.text, reply });
    const result = await reply;
    if (result.done) {
      flight.done = true;
      flight.doneAt ??= this.now();
    }
    return this.reply(flight, result.message);
  }
}

/** The route of the line agent on the desktop service. */
export function mountReachCalls(
  app: Hono,
  calls: Pick<ChertReachCalls, "lineCommand">,
) {
  app.post("/computer/reach/call/:id", async (c) => {
    const header = c.req.header("authorization") ?? "";
    const credential = header.startsWith("Bearer ") ? header.slice(7) : "";
    return c.json(
      await calls.lineCommand(
        c.req.param("id"),
        credential,
        await c.req.json(),
      ),
    );
  });
}
