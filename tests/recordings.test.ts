import { EventEmitter } from "node:events";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskApp } from "../src/control/task-app.js";
import type { TaskService } from "../src/control/task-service.js";
import {
  adminTokenFile,
  makeAdminToken,
  mountRecordingsAdmin,
} from "../src/recordings/admin.js";
import { Recordings, recordingsFolder } from "../src/recordings/store.js";
import { recordingsCli } from "../cli/recordings.js";
import {
  CONSENT_LINE,
  makeCallRecording,
  recordingSettings,
} from "../line/recording.mjs";
import { RECORDING_RATE, writeJSON } from "../line/recording-store.mjs";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});
function temp() {
  const folder = mkdtempSync(join(tmpdir(), "clawdtime-recordings-"));
  folders.push(folder);
  return folder;
}

/** One call recorded by the line agent's own code, with fakes for the room, the session and the clock. */
async function recordCall(root: string, at = "2026-11-28T10:15:00.000Z") {
  let clock = Date.parse(at);
  const before = new Set(existsSync(root) ? readdirSync(root) : []);
  const room = new EventEmitter() as EventEmitter & {
    remoteParticipants: Map<string, unknown>;
  };
  const track = { sid: "TR_audio", kind: 1 };
  room.remoteParticipants = new Map([
    [
      "chert-bridge-synthetic",
      {
        identity: "chert-bridge-synthetic",
        trackPublications: new Map([
          ["TR_audio", { sid: "TR_audio", kind: 1, track }],
        ]),
      },
    ],
  ]);
  const pushes: ((frame: unknown) => void)[] = [];
  // A constructor that gives a stream the test pushes frames into.
  const FakeAudioStream = function () {
    let controller!: ReadableStreamDefaultController;
    const stream = new ReadableStream({
      start(value) {
        controller = value;
      },
    });
    pushes.push((frame) => controller.enqueue(frame));
    return stream;
  } as unknown as new () => ReadableStream;
  const session = new EventEmitter();
  const output = { captureFrame: async (_frame: unknown) => {} };
  const recording = makeCallRecording({
    settings: recordingSettings(
      {
        CLAWDTIME_LINE_RECORDING: "on",
        CLAWDTIME_LINE_RECORDING_DIR: root,
        CLAWDTIME_LINE_RECORDING_LABEL: "test-line",
        CLAWDTIME_LINE_RECORDING_VIDEO: "off",
      },
      { home: root },
    ),
    room,
    callerIdentity: "chert-bridge-synthetic",
    callStarted: clock,
    media: { AudioStream: FakeAudioStream, KIND_AUDIO: 1, KIND_VIDEO: 2 },
    now: () => clock,
  })!;
  recording.attach(session, output);
  const frame = (value: number) => ({
    data: new Int16Array(480).fill(value),
    sampleRate: RECORDING_RATE,
    channels: 1,
    samplesPerChannel: 480,
  });
  const said = (role: string, text: string) =>
    session.emit("conversation_item_added", {
      item: { type: "message", role, textContent: text, createdAt: clock },
    });
  recording.greet("Greet the caller.");
  await output.captureFrame(frame(1200));
  said("assistant", `${CONSENT_LINE} Hi, I am ClawdTime.`);
  clock += 2000;
  pushes[0]!(frame(-800));
  await new Promise((done) => setImmediate(done));
  said("user", "What is on the Stonepad screen?");
  clock += 1500;
  said("assistant", "Stonepad shows the shop.example page.");
  clock += 1500;
  await recording.close("caller_or_session_closed");
  return readdirSync(root).find((name) => !before.has(name))!;
}

function fixture(options: { token?: boolean; others?: string[] } = {}) {
  const root = join(temp(), "recordings");
  const desktop = temp();
  const tokenFile = adminTokenFile(desktop);
  if (options.token !== false) makeAdminToken(tokenFile);
  const token = () =>
    JSON.parse(readFileSync(tokenFile, "utf8")).token as string;
  let now = Date.parse("2026-11-28T12:00:00Z");
  const app = createTaskApp({} as TaskService, "o".repeat(40));
  mountRecordingsAdmin(app, {
    recordings: () => new Recordings(root, { now: () => now }),
    tokenFile,
    port: 3320,
    otherTokens: () => ["o".repeat(40), ...(options.others ?? [])],
    now: () => now,
  });
  const get = (
    path: string,
    headers: Record<string, string> = {},
    host = "127.0.0.1:3320",
  ) => app.request(`http://${host}/admin/recordings${path}`, { headers });
  const signIn = async () => {
    const response = await get("/session", {
      authorization: `Bearer ${token()}`,
    });
    expect(response.status).toBe(200);
    return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  return {
    root,
    desktop,
    tokenFile,
    token,
    app,
    get,
    signIn,
    pass: (ms: number) => {
      now += ms;
    },
  };
}

/** The entries of a zip that this code made: names and bytes, with each checksum checked. */
function unzip(bytes: Buffer) {
  const end = bytes.length - 22;
  expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    expect(bytes.readUInt32LE(at)).toBe(0x02014b50);
    const crc = bytes.readUInt32LE(at + 16);
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const offset = bytes.readUInt32LE(at + 42);
    const name = bytes.toString("utf8", at + 46, at + 46 + nameLength);
    expect(bytes.readUInt32LE(offset)).toBe(0x04034b50);
    const start = offset + 30 + bytes.readUInt16LE(offset + 26);
    const data = bytes.subarray(start, start + size);
    expect(crc32(data) >>> 0).toBe(crc);
    entries.set(name, Buffer.from(data));
    at += 46 + nameLength;
  }
  return entries;
}

describe("call recordings: the admin page", () => {
  it("refuses every list, call and file without the admin token", async () => {
    const f = fixture();
    const id = await recordCall(f.root);
    for (const path of [
      "/api/calls",
      `/api/calls/${id}`,
      `/api/calls/${id}/files/caller.wav`,
      `/api/calls/${id}/zip`,
    ]) {
      expect((await f.get(path)).status).toBe(401);
      // The operator credential of the service is not the admin token.
      expect(
        (await f.get(path, { authorization: `Bearer ${"o".repeat(40)}` }))
          .status,
      ).toBe(401);
      expect(
        (await f.get(path, { cookie: "clawdtime_recordings=made-up" })).status,
      ).toBe(401);
    }
    expect(
      (await f.get("/session", { authorization: "Bearer wrong" })).status,
    ).toBe(401);
    // The page itself is a shell with no data in it.
    const page = await f.get("");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    const html = await page.text();
    expect(html).toContain("Call recordings");
    expect(html).not.toContain(id);
  });

  it("is off without the token file, and when the token equals another credential", async () => {
    const off = fixture({ token: false });
    const id = await recordCall(off.root);
    expect((await off.get("/api/calls")).status).toBe(403);
    expect((await off.get("/session")).status).toBe(403);
    expect((await off.get("/api/calls")).headers.get("content-type")).toContain(
      "json",
    );
    expect(id).toBeTruthy();
    const same = fixture();
    const shared = fixture({ others: [same.token()] });
    writeFileSync(
      shared.tokenFile,
      JSON.stringify({ version: 1, token: same.token() }),
      { mode: 0o600 },
    );
    expect(
      (
        await shared.get("/session", {
          authorization: `Bearer ${same.token()}`,
        })
      ).status,
    ).toBe(403);
  });

  it("serves 127.0.0.1 and localhost only, reads only, and refuses a browser origin", async () => {
    const f = fixture();
    const bearer = { authorization: `Bearer ${f.token()}` };
    expect((await f.get("/api/calls", bearer, "localhost:3320")).status).toBe(
      200,
    );
    expect(
      (await f.get("/api/calls", bearer, "rebind.example:3320")).status,
    ).toBe(403);
    expect((await f.get("/api/calls", bearer, "127.0.0.1:9999")).status).toBe(
      403,
    );
    expect(
      (
        await f.get("/api/calls", {
          ...bearer,
          origin: "https://shop.example",
        })
      ).status,
    ).toBe(403);
    const post = await f.app.request(
      "http://127.0.0.1:3320/admin/recordings/api/calls",
      {
        method: "POST",
        headers: { ...bearer, "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(post.status).toBe(405);
  });

  it("signs in once with the token: a session cookie for this path, that ends at sign out, after 8 hours or with a new token", async () => {
    const f = fixture();
    await recordCall(f.root);
    const response = await f.get("/session", {
      authorization: `Bearer ${f.token()}`,
    });
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("Path=/admin/recordings");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const session = cookie.split(";")[0]!;
    expect((await f.get("/api/calls", { cookie: session })).status).toBe(200);
    await f.get("/signout", { cookie: session });
    expect((await f.get("/api/calls", { cookie: session })).status).toBe(401);
    const later = await f.signIn();
    f.pass(8 * 3_600_000 + 1);
    expect((await f.get("/api/calls", { cookie: later })).status).toBe(401);
    const before = await f.signIn();
    makeAdminToken(f.tokenFile);
    expect((await f.get("/api/calls", { cookie: before })).status).toBe(401);
  });

  it("lists each call with its time, line, duration and parts, and shows its transcript", async () => {
    const f = fixture();
    const id = await recordCall(f.root);
    const cookie = await f.signIn();
    const { calls } = (await (
      await f.get("/api/calls", { cookie })
    ).json()) as { calls: Record<string, unknown>[] };
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      id,
      line: "test-line",
      status: "complete",
      callStartedAt: "2026-11-28T10:15:00.000Z",
      durationMs: 5000,
      recordedMs: 5000,
      stoppedBy: null,
      consent: CONSENT_LINE,
    });
    expect(
      (calls[0]!.parts as { part: string }[]).map((part) => part.part),
    ).toEqual(["transcript", "caller-audio", "agent-audio", "mixed-audio"]);
    expect(calls[0]!.missing).toEqual([
      { part: "video", reason: "Video recording is off for this line." },
    ]);
    const detail = (await (
      await f.get(`/api/calls/${id}`, { cookie })
    ).json()) as { transcript: { who: string; text: string }[] };
    expect(detail.transcript.map((turn) => [turn.who, turn.text])).toEqual([
      ["note", "Recording started."],
      ["agent", `${CONSENT_LINE} Hi, I am ClawdTime.`],
      ["caller", "What is on the Stonepad screen?"],
      ["agent", "Stonepad shows the shop.example page."],
      ["note", "The call ended."],
    ]);
  });

  it("downloads match the files byte for byte: each part, a range of a part, and the zip of the call", async () => {
    const f = fixture();
    const id = await recordCall(f.root);
    const cookie = await f.signIn();
    const folder = join(f.root, id);
    for (const name of [
      "transcript.json",
      "caller.wav",
      "agent.wav",
      "mixed.wav",
    ]) {
      const response = await f.get(
        `/api/calls/${id}/files/${name}?download=1`,
        { cookie },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toBe(
        `attachment; filename="${id}-${name}"`,
      );
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        readFileSync(join(folder, name)),
      );
    }
    const wav = await f.get(`/api/calls/${id}/files/mixed.wav`, { cookie });
    expect(wav.headers.get("content-type")).toBe("audio/wav");
    expect(wav.headers.get("content-disposition")).toContain("inline");
    const range = await f.get(`/api/calls/${id}/files/caller.wav`, {
      cookie,
      range: "bytes=44-99",
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe(
      `bytes 44-99/${statSync(join(folder, "caller.wav")).size}`,
    );
    expect(Buffer.from(await range.arrayBuffer())).toEqual(
      readFileSync(join(folder, "caller.wav")).subarray(44, 100),
    );
    const zip = await f.get(`/api/calls/${id}/zip`, { cookie });
    expect(zip.headers.get("content-type")).toBe("application/zip");
    const bytes = Buffer.from(await zip.arrayBuffer());
    const entries = unzip(bytes);
    expect([...entries.keys()]).toEqual(
      [
        "call.json",
        "transcript.json",
        "caller.wav",
        "agent.wav",
        "mixed.wav",
      ].map((name) => `${id}/${name}`),
    );
    for (const [name, data] of entries)
      expect(data).toEqual(readFileSync(join(f.root, name)));
    // A second, independent reader of the zip, when this Mac has one.
    const zipFile = join(temp(), "call.zip");
    writeFileSync(zipFile, bytes);
    const check = spawnSync("unzip", ["-tq", zipFile], { encoding: "utf8" });
    if (!check.error) expect(check.status).toBe(0);
  });

  it("serves only the parts that a call's record names, never a path out of the call or a link", async () => {
    const f = fixture();
    const id = await recordCall(f.root);
    const cookie = await f.signIn();
    for (const path of [
      `/api/calls/${id}/files/call.json`,
      `/api/calls/${id}/files/video-1.mp4`,
      `/api/calls/${id}/files/..%2Fcall.json`,
      `/api/calls/..%2F${id}/files/caller.wav`,
      `/api/calls/20261128-000000-zzzzzz/files/caller.wav`,
      `/api/calls/${id.slice(0, -1)}${id.endsWith("0") ? "1" : "0"}`,
    ])
      expect((await f.get(path, { cookie })).status, path).toBe(404);
    const secret = join(temp(), "secret.wav");
    writeFileSync(secret, "not a part", { mode: 0o600 });
    unlinkSync(join(f.root, id, "agent.wav"));
    symlinkSync(secret, join(f.root, id, "agent.wav"));
    expect(
      (await f.get(`/api/calls/${id}/files/agent.wav`, { cookie })).status,
    ).toBe(404);
  });

  it("retention: a read of the list removes each call past its own date, and a call of a stopped line shows as not finished", async () => {
    const f = fixture();
    // The newer call first: the line's own prune at the older call's time keeps it.
    const recent = await recordCall(f.root, "2026-11-27T09:00:00.000Z");
    const old = await recordCall(f.root, "2026-10-20T09:00:00.000Z");
    expect(existsSync(join(f.root, old))).toBe(true);
    const stuck = "20261128-110000-abcdef";
    mkdirSync(join(f.root, stuck), { mode: 0o700 });
    writeJSON(join(f.root, stuck, "call.json"), {
      ...JSON.parse(readFileSync(join(f.root, recent, "call.json"), "utf8")),
      id: stuck,
      status: "recording",
      // No process has this number.
      pid: 2 ** 22 + 12345,
    });
    const cookie = await f.signIn();
    const { calls } = (await (
      await f.get("/api/calls", { cookie })
    ).json()) as { calls: { id: string; status: string }[] };
    expect(calls.map((call) => [call.id, call.status])).toEqual([
      [stuck, "incomplete"],
      [recent, "complete"],
    ]);
    expect(existsSync(join(f.root, old))).toBe(false);
  });
});

describe("call recordings: the clawdtime recordings command", () => {
  function cli(root: string, answers: (string | null)[] = []) {
    const lines: string[] = [];
    const asked: string[] = [];
    const opened: string[] = [];
    const desktop = temp();
    const run = (...args: string[]) =>
      recordingsCli([...args, "--dir", root], {
        env: { CLAWDTIME_DESKTOP_STATE: desktop, VITEST: "true" },
        cwd: temp(),
        now: () => Date.parse("2026-11-28T12:00:00Z"),
        print: (line) => lines.push(line),
        ask: async (question) => {
          asked.push(question);
          return answers.shift() ?? null;
        },
        openUrl: (url) => opened.push(url),
      });
    return { run, lines, asked, opened, desktop };
  }

  it("lists and shows calls in plain words, and as JSON", async () => {
    const root = join(temp(), "recordings");
    const id = await recordCall(root);
    const c = cli(root);
    expect(await c.run("list")).toBe(0);
    expect(c.lines.at(-1)).toBe(
      `${id}  2026-11-28 10:15:00 UTC  test-line  5 s  transcript, caller audio, agent audio, both sides`,
    );
    expect(await c.run("show", id)).toBe(0);
    expect(c.lines).toContain("Duration: 5 s. Recorded: 5 s.");
    expect(c.lines).toContain(
      "  0:02  Caller: What is on the Stonepad screen?",
    );
    expect(c.lines).toContain(
      "Not recorded: video. Video recording is off for this line.",
    );
    expect(await c.run("list", "--json")).toBe(0);
    expect(JSON.parse(c.lines.at(-1)!).calls[0].id).toBe(id);
    expect(await c.run("show", "20261128-000000-000000")).toBe(1);
  });

  it("exports one call as a zip for its owner only, and never writes over a file", async () => {
    const root = join(temp(), "recordings");
    const id = await recordCall(root);
    const c = cli(root);
    const target = join(temp(), "call.zip");
    expect(await c.run("export", id, "--to", target)).toBe(0);
    expect(lstatSync(target).mode & 0o777).toBe(0o600);
    const entries = unzip(readFileSync(target));
    expect(entries.get(`${id}/mixed.wav`)).toEqual(
      readFileSync(join(root, id, "mixed.wav")),
    );
    expect(await c.run("export", id, "--to", target)).toBe(1);
  });

  it("delete asks first: only yes deletes, and with no terminal it needs --yes", async () => {
    const root = join(temp(), "recordings");
    const id = await recordCall(root);
    const c = cli(root, ["no", null, "yes"]);
    expect(await c.run("delete", id)).toBe(1);
    expect(c.asked[0]).toContain(`Delete the call ${id}`);
    expect(c.lines.at(-1)).toBe("Nothing was deleted.");
    expect(existsSync(join(root, id))).toBe(true);
    expect(await c.run("delete", id)).toBe(1);
    expect(c.lines.at(-1)).toContain("Add --yes");
    expect(existsSync(join(root, id))).toBe(true);
    expect(await c.run("delete", id)).toBe(0);
    expect(existsSync(join(root, id))).toBe(false);
    const other = await recordCall(root);
    expect(await c.run("delete", other, "--yes")).toBe(0);
    expect(existsSync(join(root, other))).toBe(false);
  });

  it("admin makes an owner-only token, prints the address and never the token, and opens the page with it after #", async () => {
    const root = join(temp(), "recordings");
    const c = cli(root);
    expect(await c.run("admin")).toBe(0);
    const file = adminTokenFile(c.desktop);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    const token = JSON.parse(readFileSync(file, "utf8")).token as string;
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(c.lines[0]).toBe(
      "The admin page: http://127.0.0.1:3320/admin/recordings",
    );
    expect(c.lines.join("\n")).not.toContain(token);
    expect(await c.run("admin", "--open")).toBe(0);
    expect(c.opened).toEqual([
      `http://127.0.0.1:3320/admin/recordings#token=${token}`,
    ]);
    expect(await c.run("admin", "--new")).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8")).token).not.toBe(token);
  });

  it("finds the same folder as the line agent", () => {
    expect(recordingsFolder({}, "/Users/synthetic")).toBe(
      "/Users/synthetic/.local/share/clawdtime/line/recordings",
    );
    expect(
      recordingsFolder({ CLAWDTIME_LINE_STATE: "/srv/line" }, "/home/x"),
    ).toBe("/srv/line/recordings");
    expect(
      recordingsFolder({ CLAWDTIME_LINE_RECORDING_DIR: "relative" }, "/home/x"),
    ).toBeNull();
    expect(
      recordingSettings(
        { CLAWDTIME_LINE_RECORDING: "on" },
        { home: "/Users/synthetic" },
      ).root,
    ).toBe(recordingsFolder({}, "/Users/synthetic"));
  });
});
