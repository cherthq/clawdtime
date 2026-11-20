import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentsCli } from "../cli/agents.js";
import { BoardScanner } from "../connectors/agents/board.js";
import { Supervisor } from "../connectors/agents/brain.js";
import { sayByCall, type CallClient } from "../connectors/agents/call.js";
import {
  DecisionDesk,
  describeRequest,
} from "../connectors/agents/decisions.js";
import { BoardFeed } from "../connectors/agents/feed.js";
import {
  boardSnapshotSchema,
  type AgentSession,
  type BoardSnapshot,
} from "../connectors/agents/types.js";
import {
  defaultRules,
  incidentSchema,
  incidentSentence,
  incidentsView,
  renderIncidents,
  renderRules,
  Watcher,
  WatchStore,
  type Incident,
  type WatchRules,
} from "../connectors/agents/watch.js";
import { fakeSystem } from "./connectors-agents-fixture.js";
import { fileURLToPath } from "node:url";

/**
 * The watcher is a reducer over board snapshots. Each test scripts a run of
 * snapshots with a clock that the test moves, and reads what was raised and
 * what was cleared. No process is started and no call is placed.
 */
const start = new Date(2026, 10, 20, 12, 0, 0).getTime();
const minute = 60_000;
const root = () => mkdtempSync(join(tmpdir(), "clawdtime-watch-"));

const session = (values: Partial<AgentSession> = {}): AgentSession => ({
  id: "100-abc",
  pid: 100,
  agent: "claude-code",
  agentLabel: "Claude Code",
  agentVersion: null,
  name: "deploy fix",
  project: "app",
  cwd: "/work/app",
  mode: "interactive",
  state: "working",
  detail: "turn_running",
  since: start,
  source: "registry",
  startedAt: start - 60 * minute,
  spawnedBy: null,
  terminal: {
    tty: "ttys001",
    app: "Terminal",
    appPath: null,
    tmux: null,
    remote: false,
  },
  focus: "tab",
  ...values,
});
const board = (
  at: number,
  sessions: AgentSession[],
  hosts?: BoardSnapshot["hosts"],
): BoardSnapshot =>
  boardSnapshotSchema.parse({
    version: 1,
    generatedAt: at,
    intervalMs: 3000,
    counts: {
      needs_you: sessions.filter((item) => item.state === "needs_you").length,
      working: sessions.filter((item) => item.state === "working").length,
      idle: sessions.filter((item) => item.state === "idle").length,
      unknown: sessions.filter((item) => item.state === "unknown").length,
    },
    sessions,
    ...(hosts ? { hosts } : {}),
  });

/** A watcher on a clock that the test moves. */
function watching(
  options: {
    rules?: Partial<WatchRules>;
    exists?: (pid: number) => boolean;
    store?: WatchStore;
  } = {},
) {
  const clock = { now: start };
  const watcher = new Watcher({
    now: () => clock.now,
    rules: () => ({ ...defaultRules, ...options.rules }),
    exists: options.exists ?? (() => false),
    store: options.store,
  });
  const scan = (
    at: number,
    sessions: AgentSession[],
    hosts?: BoardSnapshot["hosts"],
  ) => {
    clock.now = at;
    return watcher.observe(board(at, sessions, hosts));
  };
  const kinds = () => watcher.open().map((incident) => incident.kind);
  return { watcher, scan, kinds, clock };
}

describe("the watcher: what it catches", () => {
  it("reports a session that has needed the person for too long, once, and clears it when the session moves on", () => {
    const { watcher, scan, kinds } = watching();
    const asks = session({
      state: "needs_you",
      detail: "permission_prompt",
      since: start,
    });
    expect(scan(start + 60_000, [asks]).raised).toEqual([]);
    expect(scan(start + 119_000, [asks]).raised).toEqual([]);
    const { raised } = scan(start + 120_000, [asks]);
    expect(raised).toMatchObject([
      {
        kind: "waiting",
        sessionId: "100-abc",
        title: "deploy fix",
        agentLabel: "Claude Code",
        since: start,
        workedMs: null,
        cause: null,
        raisedAt: start + 120_000,
      },
    ]);
    expect(raised[0]!.id).toMatch(/^[0-9a-f]{12}$/);
    expect(incidentSentence(raised[0]!, start + 5 * minute)).toBe(
      "deploy fix has waited for you for 5m.",
    );
    // The same wait is one incident, however many scans see it.
    for (let step = 1; step <= 5; step++)
      expect(scan(start + 120_000 + step * 3000, [asks]).raised).toEqual([]);
    expect(kinds()).toEqual(["waiting"]);
    // A new request of the same session is a new decision point.
    const again = { ...asks, since: start + 10 * minute };
    expect(scan(start + 11 * minute, [again]).raised).toEqual([]);
    const next = scan(start + 12 * minute, [again]);
    expect(next.raised).toMatchObject([
      { kind: "waiting", since: start + 10 * minute },
    ]);
    expect(next.cleared).toMatchObject([{ kind: "waiting", since: start }]);
    expect(watcher.open()).toHaveLength(1);
    // The person answered: it works again, and the incident is gone.
    const moved = scan(start + 13 * minute, [
      session({ since: start + 13 * minute }),
    ]);
    expect(moved.cleared).toMatchObject([{ kind: "waiting" }]);
    expect(kinds()).toEqual([]);
  });

  it("counts a wait from the time it first saw it, when the agent gives no time", () => {
    const { scan, kinds } = watching();
    const asks = session({
      state: "needs_you",
      detail: "question",
      since: null,
    });
    scan(start, [asks]);
    scan(start + 119_000, [asks]);
    expect(kinds()).toEqual([]);
    expect(scan(start + 121_000, [asks]).raised).toMatchObject([
      { kind: "waiting", since: start },
    ]);
  });

  it("reports a session that works with no sign of life, and says nothing without that time", () => {
    const { scan, kinds } = watching();
    const silent = session({ activeAt: start });
    expect(scan(start + 9 * minute, [silent]).raised).toEqual([]);
    const { raised } = scan(start + 10 * minute, [silent]);
    expect(raised).toMatchObject([{ kind: "stalled", since: start }]);
    expect(incidentSentence(raised[0]!, start + 12 * minute)).toBe(
      "deploy fix has shown no sign of life for 12m.",
    );
    expect(scan(start + 11 * minute, [silent]).raised).toEqual([]);
    // It wrote again: it lives, and the incident is cleared.
    const alive = scan(start + 12 * minute, [
      session({ activeAt: start + 12 * minute - 2000 }),
    ]);
    expect(alive.cleared).toMatchObject([{ kind: "stalled" }]);
    expect(kinds()).toEqual([]);
    // It goes silent again later: that is a new incident.
    expect(
      scan(start + 30 * minute, [
        session({ activeAt: start + 12 * minute - 2000 }),
      ]).raised,
    ).toMatchObject([{ kind: "stalled", since: start + 12 * minute - 2000 }]);

    // No time of a sign of life: an hour of work is only an hour of work.
    const blind = watching();
    blind.scan(start, [session()]);
    expect(blind.scan(start + 60 * minute, [session()]).raised).toEqual([]);
    // A session that only waits for a background shell is not stalled.
    const shell = watching();
    expect(
      shell.scan(start + 60 * minute, [
        session({ detail: "background_shell", activeAt: start }),
      ]).raised,
    ).toEqual([]);
    // A session that needs the person is waiting, not stalled.
    const asking = watching();
    expect(
      asking
        .scan(start + 60 * minute, [
          session({ state: "needs_you", detail: "question", activeAt: start }),
        ])
        .raised.map((incident) => incident.kind),
    ).toEqual(["waiting"]);
  });

  it("reports work that is done, and only work that was long enough", () => {
    const { scan, kinds, watcher } = watching();
    scan(start, [session({ since: start })]);
    const done = session({
      state: "idle",
      detail: "turn_complete",
      since: start + 12 * minute,
    });
    const { raised } = scan(start + 12 * minute + 3000, [done]);
    expect(raised).toMatchObject([
      {
        kind: "finished",
        since: start + 12 * minute,
        workedMs: 12 * minute,
        cause: null,
      },
    ]);
    expect(incidentSentence(raised[0]!, start + 13 * minute)).toBe(
      "deploy fix is done after 12m.",
    );
    // It stays idle: nothing more is said.
    expect(scan(start + 13 * minute, [done]).raised).toEqual([]);
    expect(kinds()).toEqual(["finished"]);
    // The news leaves the view after ten minutes.
    expect(scan(start + 22 * minute + 2000, [done]).cleared).toEqual([]);
    expect(scan(start + 22 * minute + 4000, [done]).cleared).toMatchObject([
      { kind: "finished" },
    ]);
    expect(watcher.open()).toEqual([]);

    // Two minutes of work end with no word. So does work that the person interrupted.
    const short = watching();
    short.scan(start, [session({ since: start })]);
    expect(
      short.scan(start + 2 * minute, [
        session({
          state: "idle",
          detail: "turn_complete",
          since: start + 2 * minute,
        }),
      ]).raised,
    ).toEqual([]);
    const stopped = watching();
    stopped.scan(start, [session({ since: start })]);
    expect(
      stopped.scan(start + 20 * minute, [
        session({
          state: "idle",
          detail: "turn_interrupted",
          since: start + 20 * minute,
        }),
      ]).raised,
    ).toEqual([]);
    // A session that is first seen idle did no work that the watcher saw.
    const quiet = watching();
    expect(
      quiet.scan(start, [session({ state: "idle", detail: "turn_complete" })])
        .raised,
    ).toEqual([]);
    // A request in the middle does not cut the work in two.
    const long = watching();
    long.scan(start, [session({ since: start })]);
    long.scan(start + 5 * minute, [
      session({
        state: "needs_you",
        detail: "permission_prompt",
        since: start + 5 * minute,
      }),
    ]);
    long.scan(start + 6 * minute, [session({ since: start + 6 * minute })]);
    expect(
      long.scan(start + 15 * minute, [
        session({
          state: "idle",
          detail: "turn_complete",
          since: start + 15 * minute,
        }),
      ]).raised,
    ).toMatchObject([{ kind: "finished", workedMs: 15 * minute }]);
  });

  it("reports a session that stopped on an error or whose process ended in the middle of its work", () => {
    const { scan } = watching();
    scan(start, [session({ since: start })]);
    const error = scan(start + 8 * minute, [
      session({
        state: "idle",
        detail: "turn_failed",
        since: start + 8 * minute,
      }),
    ]);
    expect(error.raised).toMatchObject([
      { kind: "failed", cause: "error", workedMs: 8 * minute },
    ]);
    expect(incidentSentence(error.raised[0]!, start + 9 * minute)).toBe(
      "deploy fix stopped on an error after 8m.",
    );

    // Gone from the board while it worked: one scan can miss it, two are an end.
    const gone = watching();
    gone.scan(start, [session({ since: start })]);
    expect(gone.scan(start + 3000, []).raised).toEqual([]);
    const ended = gone.scan(start + 6000, []);
    expect(ended.raised).toMatchObject([
      {
        kind: "failed",
        cause: "gone",
        sessionId: "100-abc",
        since: start + 6000,
      },
    ]);
    expect(incidentSentence(ended.raised[0]!, start + 7000)).toBe(
      "deploy fix is gone: its process ended in the middle of its work.",
    );
    // It is said once.
    expect(gone.scan(start + 9000, []).raised).toEqual([]);

    // Back after one missed scan: nothing happened.
    const blink = watching();
    blink.scan(start, [session()]);
    blink.scan(start + 3000, []);
    blink.scan(start + 6000, [session()]);
    expect(blink.scan(start + 9000, []).raised).toEqual([]);
    expect(blink.scan(start + 12_000, []).raised).toMatchObject([
      { kind: "failed" },
    ]);

    // It also dies while it waits for the person: that request will never be answered.
    const asked = watching();
    asked.scan(start, [session({ state: "needs_you", detail: "question" })]);
    asked.scan(start + 3000, []);
    expect(asked.scan(start + 6000, []).raised).toMatchObject([
      { kind: "failed", cause: "gone" },
    ]);
  });

  it("never reports a session that the person put away, a run that ends by design, or a scan that lost a process", () => {
    // Closed while idle.
    const idle = watching();
    idle.scan(start, [session({ state: "idle", detail: "turn_complete" })]);
    idle.scan(start + 3000, []);
    expect(idle.scan(start + 6000, []).raised).toEqual([]);
    // A one-shot run has no person at a terminal and ends by design.
    const headless = watching();
    headless.scan(start, [session({ mode: "headless" })]);
    headless.scan(start + 3000, []);
    expect(headless.scan(start + 6000, []).raised).toEqual([]);
    // A detached session is listed by its agent: a listing that fails is not an end.
    const detached = watching();
    detached.scan(start, [
      session({ id: "bg-4c49bc33", pid: null, mode: "background" }),
    ]);
    detached.scan(start + 3000, []);
    expect(detached.scan(start + 6000, []).raised).toEqual([]);
    // The process is still there: the scan missed it.
    const asked: number[] = [];
    const lost = watching({
      exists: (pid) => {
        asked.push(pid);
        return true;
      },
    });
    lost.scan(start, [session()]);
    lost.scan(start + 3000, []);
    expect(lost.scan(start + 6000, []).raised).toEqual([]);
    expect(asked).toEqual([100]);
  });

  it("says nothing about the sessions of a remote Mac that does not answer", () => {
    const remote = session({
      id: "mini_512-abc",
      pid: 512,
      host: "mini",
      name: "ios build",
    });
    const answering = [
      { name: "mini", ok: true, sessions: 1, checkedAt: start, message: "" },
    ];
    const silent = [
      {
        name: "mini",
        ok: false,
        sessions: 0,
        checkedAt: start,
        message: "No answer.",
      },
    ];
    const { scan } = watching({ exists: () => true });
    scan(start, [remote], answering);
    for (let step = 1; step <= 5; step++)
      expect(scan(start + step * 3000, [], silent).raised).toEqual([]);
    // It answers again and the session is there: nothing happened.
    expect(scan(start + 18_000, [remote], answering).raised).toEqual([]);
    // It answers and the session is not there, twice: that session ended. The
    // process check is for this Mac only, so it is not asked.
    scan(start + 21_000, [], answering);
    const ended = scan(start + 24_000, [], answering);
    expect(ended.raised).toMatchObject([
      {
        kind: "failed",
        cause: "gone",
        host: "mini",
        sessionId: "mini_512-abc",
      },
    ]);
    expect(incidentSentence(ended.raised[0]!, start + 25_000)).toBe(
      "ios build on mini is gone: its process ended in the middle of its work.",
    );
    // A Mac that left the host book takes its sessions with it, silently.
    const removed = watching();
    removed.scan(start, [remote], answering);
    removed.scan(start + 3000, []);
    expect(removed.scan(start + 6000, []).raised).toEqual([]);
  });

  it("orders what it found by urgency, lets the person dismiss one, and never raises it again", () => {
    const { watcher, scan, kinds } = watching();
    const sessions = [
      session({
        id: "1-a",
        pid: 1,
        name: "one",
        since: start,
        activeAt: start,
      }),
      session({
        id: "2-b",
        pid: 2,
        name: "two",
        state: "needs_you",
        detail: "question",
        since: start + minute,
      }),
      session({ id: "3-c", pid: 3, name: "three", since: start }),
      session({ id: "4-d", pid: 4, name: "four", since: start }),
    ];
    scan(start, sessions);
    scan(start + 3000, sessions.slice(0, 3));
    scan(start + 11 * minute, [
      sessions[0]!,
      sessions[1]!,
      session({
        id: "3-c",
        pid: 3,
        name: "three",
        state: "idle",
        detail: "turn_complete",
        since: start + 11 * minute,
      }),
    ]);
    // Failed first, then the wait, the stall, and the quiet news of finished work last.
    expect(kinds()).toEqual(["failed", "waiting", "stalled", "finished"]);
    expect(watcher.open().map((incident) => incident.title)).toEqual([
      "four",
      "two",
      "one",
      "three",
    ]);
    const stalled = watcher.open()[2]!;
    expect(watcher.dismiss(stalled.id)).toBe(true);
    expect(watcher.dismiss(stalled.id)).toBe(false);
    expect(watcher.dismiss("0123456789ab")).toBe(false);
    // The stall goes on. It was seen: it does not come back.
    expect(
      scan(start + 12 * minute, [sessions[0]!, sessions[1]!]).raised,
    ).toEqual([]);
    expect(kinds()).toEqual(["failed", "waiting", "finished"]);
    // The view carries each incident with its sentence, counted now.
    const view = incidentsView(watcher.open(), start + 12 * minute);
    expect(view.version).toBe(1);
    expect(view.incidents.map((incident) => incident.text)).toEqual([
      "four is gone: its process ended in the middle of its work.",
      "two has waited for you for 11m.",
      "three is done after 11m.",
    ]);
    // An incident holds names and times only.
    expect(Object.keys(view.incidents[0]!).sort()).toEqual(
      [
        "agentLabel",
        "cause",
        "id",
        "kind",
        "raisedAt",
        "sessionId",
        "since",
        "text",
        "title",
        "version",
        "workedMs",
      ].sort(),
    );
  });
});

describe("the watcher's rules, log and files", () => {
  it("keeps its rules in an owner-only file and refuses a limit under 30 seconds", () => {
    const directory = root();
    const store = new WatchStore(directory);
    expect(store.rules()).toEqual(defaultRules);
    expect(defaultRules).toEqual({
      version: 1,
      waitSeconds: 120,
      stallSeconds: 600,
      finishedSeconds: 180,
      callOn: ["waiting", "failed"],
    });
    expect(store.setRule("wait", "5m").waitSeconds).toBe(300);
    expect(store.setRule("stall", "1h").stallSeconds).toBe(3600);
    expect(store.setRule("finished", "45").finishedSeconds).toBe(45);
    expect(store.setRule("finished", "90s").finishedSeconds).toBe(90);
    expect(store.setRule("call", "failed, stalled,failed").callOn).toEqual([
      "failed",
      "stalled",
    ]);
    expect(store.setRule("call", "none").callOn).toEqual([]);
    expect(new WatchStore(directory).rules()).toMatchObject({
      waitSeconds: 300,
      stallSeconds: 3600,
      finishedSeconds: 90,
      callOn: [],
    });
    const file = join(directory, "agents", "watch.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(() => store.setRule("wait", "29")).toThrow("under 30 seconds");
    expect(() => store.setRule("stall", "10s")).toThrow("under 30 seconds");
    expect(() => store.setRule("wait", "2d")).toThrow("such as 90");
    expect(() => store.setRule("wait", "25h")).toThrow("one day");
    expect(() => store.setRule("speed", "60")).toThrow(
      "wait, stall, finished and call",
    );
    expect(() => store.setRule("call", "angry")).toThrow(
      '"angry" is not a kind',
    );
    // Nothing above changed the file after the last good write.
    expect(new WatchStore(directory).rules().waitSeconds).toBe(300);
    // A file that is not valid gives the defaults, not a crash and not a wider rule.
    writeFileSync(file, '{"version":1,"waitSeconds":1}');
    expect(store.rules()).toEqual(defaultRules);
    expect(renderRules(defaultRules)).toBe(
      [
        "Watch rules",
        "  wait      2m     a session that needs you for this long is reported",
        "  stall     10m    a session that works with no sign of life for this long is reported",
        "  finished  3m     work shorter than this ends with no word",
        "  call      waiting, failed: the kinds that may place a call in away mode",
        "Change one: clawdtime agents watch-rules set wait 5m",
      ].join("\n"),
    );
  });

  it("writes what is open for other readers, keeps a bounded log, and keeps ended news over a restart", () => {
    const directory = root();
    const store = new WatchStore(directory);
    expect(store.readOpen(start)).toEqual({ live: false, incidents: [] });
    expect(store.recent()).toEqual([]);
    const { watcher, scan } = watching({ store });
    scan(start, [session({ since: start })]);
    scan(start + 5 * minute, [
      session({
        state: "idle",
        detail: "turn_complete",
        since: start + 5 * minute,
      }),
    ]);
    const open = store.readOpen(start + 5 * minute + 20_000);
    expect(open.live).toBe(true);
    expect(open.incidents).toEqual(watcher.open());
    // A reader a minute later knows that no watcher runs: what it has is not shown as current.
    expect(store.readOpen(start + 7 * minute)).toEqual({
      live: false,
      incidents: [],
    });
    // With no change the file is still written now and then, so a reader sees that the watcher lives.
    scan(start + 7 * minute, [
      session({
        state: "idle",
        detail: "turn_complete",
        since: start + 5 * minute,
      }),
    ]);
    expect(store.readOpen(start + 7 * minute + 30_000).live).toBe(true);
    for (const name of ["watch-open.json", "incidents.jsonl"])
      expect(statSync(join(directory, "agents", name)).mode & 0o777).toBe(
        0o600,
      );
    expect(store.recent()).toMatchObject([
      {
        event: "raised",
        at: start + 5 * minute,
        incident: { kind: "finished" },
      },
    ]);

    // A new watcher on the same folder, as after a restart of the service.
    const clock = { now: start + 8 * minute };
    const next = new Watcher({
      now: () => clock.now,
      store,
      exists: () => false,
    });
    expect(next.open().map((incident) => incident.kind)).toEqual(["finished"]);
    expect(next.dismiss(next.open()[0]!.id)).toBe(true);
    expect(store.recent(1)).toMatchObject([{ event: "dismissed" }]);
    expect(store.readOpen(clock.now).incidents).toEqual([]);
    // A watcher that starts after the news has had its ten minutes does not show it again.
    const late = new WatchStore(root());
    const first = watching({ store: late });
    first.scan(start, [session({ since: start })]);
    first.scan(start + 5 * minute, [
      session({
        state: "idle",
        detail: "turn_complete",
        since: start + 5 * minute,
      }),
    ]);
    expect(
      new Watcher({ now: () => start + 14 * minute, store: late }).open(),
    ).toHaveLength(1);
    expect(
      new Watcher({ now: () => start + 16 * minute, store: late }).open(),
    ).toEqual([]);

    // The log is cut back to its last 500 lines once it passes 600.
    const one = watcher.open()[0] ?? next.open()[0];
    const incident: Incident = one ?? {
      version: 1,
      id: "0123456789ab",
      kind: "finished",
      sessionId: "100-abc",
      title: "deploy fix",
      agentLabel: "Claude Code",
      since: start,
      workedMs: null,
      cause: null,
      raisedAt: start,
    };
    for (let index = 0; index < 640; index++)
      store.log("raised", incident, start + index);
    const lines = readFileSync(
      join(directory, "agents", "incidents.jsonl"),
      "utf8",
    )
      .split("\n")
      .filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(600);
    expect(lines.length).toBeGreaterThanOrEqual(500);
    // Newest first, and a line that does not parse is skipped.
    writeFileSync(
      join(directory, "agents", "incidents.jsonl"),
      `${lines.slice(-3).join("\n")}\n{broken\n`,
    );
    expect(store.recent().map((entry) => entry.at)).toEqual([
      start + 639,
      start + 638,
      start + 637,
    ]);
  });
});

describe("a call that tells what the watcher found", () => {
  const client = (
    pages: { turns: unknown[]; request?: { state: string } }[],
    log: string[],
  ): CallClient => {
    let page = 0;
    return {
      async requestAttention(input) {
        log.push(`call ${input.idempotencyKey}: ${input.question}`);
        return { request: { id: "att", state: "requested" } };
      },
      async conversationTurns() {
        return pages[Math.min(page++, pages.length - 1)]!;
      },
      async conversationOperation(_id, operation, body) {
        log.push(`${operation} ${JSON.stringify(body)}`);
        return {};
      },
      async heartbeat() {
        return {};
      },
    };
  };
  const options = {
    now: () => start,
    deadline: start + 90_000,
    key: "abc",
    pollMs: 1,
    beatMs: 100_000,
  };

  it("says the sentence and ends when the person says a word", async () => {
    const log: string[] = [];
    const result = await sayByCall(
      client(
        [
          { turns: [], request: { state: "connected" } },
          {
            turns: [{ id: "t1", sequence: 1, text: "okay thanks" }],
            request: { state: "connected" },
          },
        ],
        log,
      ),
      "deploy fix is gone: its process ended in the middle of its work.",
      options,
    );
    expect(result).toBe("heard");
    expect(log[0]).toBe(
      "call incident-abc: deploy fix is gone: its process ended in the middle of its work. Say okay when you have heard this.",
    );
    expect(log).toContain(
      'reply {"turnId":"t1","replyId":"reply-t1","text":"Okay.","expectedCursor":1}',
    );
    expect(log.at(-1)).toBe("end {}");
  });

  it("ends when the person hangs up, and when the time runs out", async () => {
    const log: string[] = [];
    expect(
      await sayByCall(
        client([{ turns: [], request: { state: "disconnected" } }], log),
        "x",
        options,
      ),
    ).toBe("ended");
    expect(log.filter((line) => line.startsWith("reply"))).toEqual([]);
    let clock = start;
    expect(
      await sayByCall(
        client([{ turns: [], request: { state: "connected" } }], []),
        "x",
        {
          ...options,
          now: () => (clock += 40_000),
        },
      ),
    ).toBe("time");
  });
});

describe("the watcher in the service", () => {
  const line = (snapshot: BoardSnapshot) => `${JSON.stringify(snapshot)}\n`;
  const tick = () => new Promise((done) => setTimeout(done, 5));

  it("watches each snapshot, shows what it found, and lets the person dismiss it", () => {
    const clock = { now: start };
    const feed = new BoardFeed({
      root: root(),
      now: () => clock.now,
      model: null,
      speech: null,
      exists: () => false,
    });
    expect(feed.incidents()).toEqual({ version: 1, incidents: [] });
    feed.receive(
      line(board(start, [session({ since: start, activeAt: start })])),
    );
    clock.now = start + 10 * minute;
    feed.receive(
      line(board(clock.now, [session({ since: start, activeAt: start })])),
    );
    const view = feed.incidents();
    expect(view.incidents).toMatchObject([
      {
        kind: "stalled",
        text: "deploy fix has shown no sign of life for 10m.",
      },
    ]);
    // A line that is not a snapshot changes nothing.
    feed.receive("{not json}\n");
    expect(feed.incidents().incidents).toHaveLength(1);
    expect(feed.dismissIncident(view.incidents[0]!.id)).toBe(true);
    expect(feed.dismissIncident(view.incidents[0]!.id)).toBe(false);
    expect(feed.incidents().incidents).toEqual([]);
  });

  it("an agent that waits gets the line before news: no incident is told until its call was placed", async () => {
    const clock = { now: start };
    const told: string[] = [];
    const asked: string[] = [];
    let answer: (() => void) | undefined;
    const feed = new BoardFeed({
      root: root(),
      now: () => clock.now,
      model: null,
      speech: null,
      exists: () => false,
      notify: async (incident) => {
        told.push(incident.kind);
      },
      call: (item) =>
        new Promise((done) => {
          asked.push(item.id);
          answer = () => done({ decision: "allow", text: null });
        }),
    });
    const scan = (at: number, sessions: AgentSession[]) => {
      clock.now = at;
      feed.receive(line(board(at, sessions)));
    };
    const one = session({ id: "1-a", pid: 1, name: "one", since: start });
    const two = session({ id: "2-b", pid: 2, name: "two", since: start });
    feed.setAway(true);
    scan(start, [one, two]);
    // An agent asks, and a session dies in the same moments.
    const waiting = feed.desk.open({
      agent: "claude-code",
      sessionId: "s",
      cwd: "/work/app",
      pids: [],
      described: describeRequest({
        session_id: "s",
        cwd: "/work/app",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
      })!,
      holdSeconds: 540,
    });
    scan(start + 3000, [one]);
    scan(start + 6000, [one]);
    expect(feed.incidents().incidents.map((item) => item.kind)).toEqual([
      "failed",
    ]);
    await tick();
    // The news waits: the request has not had its call yet.
    expect(told).toEqual([]);
    feed.superviseAway();
    await tick();
    expect(asked).toEqual([waiting.id]);
    // While that call runs, the news still waits.
    scan(start + 9000, [one]);
    await tick();
    expect(told).toEqual([]);
    answer!();
    await tick();
    scan(start + 12_000, [one]);
    await tick();
    expect(told).toEqual(["failed"]);
  });

  it("places one call for an incident in away mode, for the kinds that the rules allow, and never two at once", async () => {
    const directory = root();
    const clock = { now: start };
    const calls: string[] = [];
    let hangUp: (() => void) | undefined;
    const feed = new BoardFeed({
      root: directory,
      now: () => clock.now,
      model: null,
      speech: null,
      exists: () => false,
      notify: (incident, sentence) => {
        calls.push(`${incident.kind}: ${sentence}`);
        return new Promise<void>((done) => {
          hangUp = done;
        });
      },
    });
    const scan = (at: number, sessions: AgentSession[]) => {
      clock.now = at;
      feed.receive(line(board(at, sessions)));
    };
    const one = session({
      id: "1-a",
      pid: 1,
      name: "one",
      since: start,
      activeAt: start,
    });
    const two = session({ id: "2-b", pid: 2, name: "two", since: start });
    const three = session({ id: "3-c", pid: 3, name: "three", since: start });
    // Here, not away: the watcher finds, nothing calls.
    scan(start, [one, two, three]);
    scan(start + 3000, [one, three]);
    scan(start + 6000, [one, three]);
    expect(feed.incidents().incidents.map((item) => item.kind)).toEqual([
      "failed",
    ]);
    await tick();
    expect(calls).toEqual([]);
    // Away: the session that died is told by phone, once.
    feed.setAway(true);
    scan(start + 9000, [one, three]);
    scan(start + 12_000, [one, three]);
    await tick();
    expect(calls).toEqual([
      "failed: two is gone: its process ended in the middle of its work.",
    ]);
    // A second session dies while that call runs: it waits, it does not call over it.
    scan(start + 15_000, [one]);
    scan(start + 18_000, [one]);
    expect(feed.incidents().incidents.map((item) => item.title)).toEqual([
      "two",
      "three",
    ]);
    await tick();
    expect(calls).toHaveLength(1);
    hangUp!();
    await tick();
    scan(start + 21_000, [one]);
    await tick();
    expect(calls).toEqual([
      "failed: two is gone: its process ended in the middle of its work.",
      "failed: three is gone: its process ended in the middle of its work.",
    ]);
    hangUp!();
    await tick();
    // A stall is not in the default kinds: it shows, and it does not call.
    scan(start + 11 * minute, [one]);
    expect(feed.incidents().incidents.map((item) => item.kind)).toContain(
      "stalled",
    );
    await tick();
    expect(calls).toHaveLength(2);
    // The person allows calls for a stall: now it is told, once.
    new WatchStore(directory).setRule("call", "failed,stalled");
    scan(start + 11 * minute + 3000, [one]);
    scan(start + 11 * minute + 6000, [one]);
    await tick();
    expect(calls).toHaveLength(3);
    expect(calls[2]).toBe("stalled: one has shown no sign of life for 11m.");
    hangUp!();
    await tick();
    scan(start + 11 * minute + 9000, [one]);
    await tick();
    expect(calls).toHaveLength(3);
  });

  it("does not call with no phone link, and a failed call leaves the incident in view", async () => {
    const clock = { now: start };
    const feed = new BoardFeed({
      root: root(),
      now: () => clock.now,
      model: null,
      speech: null,
      exists: () => false,
    });
    feed.setAway(true);
    feed.receive(line(board(start, [session()])));
    clock.now = start + 3000;
    feed.receive(line(board(clock.now, [])));
    clock.now = start + 6000;
    // No link and no call function: nothing throws and the incident shows.
    feed.receive(line(board(clock.now, [])));
    expect(feed.incidents().incidents.map((item) => item.kind)).toEqual([
      "failed",
    ]);

    const broken = new BoardFeed({
      root: root(),
      now: () => clock.now,
      model: null,
      speech: null,
      exists: () => false,
      notify: async () => {
        throw new Error("no line");
      },
    });
    broken.setAway(true);
    clock.now = start;
    broken.receive(line(board(start, [session()])));
    clock.now = start + 3000;
    broken.receive(line(board(clock.now, [])));
    clock.now = start + 6000;
    broken.receive(line(board(clock.now, [])));
    await tick();
    expect(broken.incidents().incidents.map((item) => item.kind)).toEqual([
      "failed",
    ]);
  });

  it("puts what the watcher found into the agent's own status", () => {
    const desk = new DecisionDesk(root(), () => start);
    const world = {
      now: () => start,
      board: () => board(start, [session()]),
      desk,
      focus: async () => ({ ok: true }),
      send: async () => ({ ok: true, route: "tmux" }),
      clis: () => [],
    };
    expect(new Supervisor(world, null).status()).not.toContain("watcher");
    const status = new Supervisor(
      {
        ...world,
        incidents: () => [
          "deploy fix has shown no sign of life for 12m.",
          "docs is done after 20m.",
        ],
      },
      null,
    ).status();
    expect(status).toContain(
      "The watcher found 2:\n- deploy fix has shown no sign of life for 12m.\n- docs is done after 20m.",
    );
  });
});

describe("the sign of life on the board", () => {
  it("takes the newest time that the evidence shows, and the session file's time for Claude Code", () => {
    const home = "/Users/tester";
    const system = fakeSystem({
      now: start,
      home,
      processes: [
        {
          pid: 20,
          ppid: 1,
          tty: "ttys001",
          startedAt: start - 90 * minute,
          exe: "Terminal",
        },
        {
          pid: 100,
          ppid: 20,
          tty: "ttys001",
          startedAt: start - 50 * minute,
          exe: "claude",
          cwd: "/work/app",
        },
        {
          pid: 200,
          ppid: 20,
          tty: "ttys001",
          startedAt: start - 50 * minute,
          exe: "claude",
          cwd: "/work/site",
        },
        {
          pid: 300,
          ppid: 20,
          tty: "ttys001",
          startedAt: start - 50 * minute,
          exe: "amp",
          cwd: home,
        },
      ],
      files: {
        [`${home}/.claude/sessions/100.json`]: {
          text: JSON.stringify({
            pid: 100,
            startedAt: start - 50 * minute,
            status: "busy",
            statusUpdatedAt: start - 30 * minute,
            updatedAt: start - 30 * minute,
            sessionId: "0b0f6f5e-3c1a-4f7e-9d2c-6d1f0a9b8c7d",
            cwd: "/work/app",
          }),
        },
        // The session's own file: it changed two minutes ago, long after the status did.
        [`${home}/.claude/projects/-work-app/0b0f6f5e-3c1a-4f7e-9d2c-6d1f0a9b8c7d.jsonl`]:
          {
            text: "{}\n",
            mtimeMs: start - 2 * minute,
          },
        [`${home}/.claude/sessions/200.json`]: {
          text: JSON.stringify({
            pid: 200,
            startedAt: start - 50 * minute,
            status: "busy",
            statusUpdatedAt: start - 7 * minute,
            // A session id that could leave the folder is never used as a path.
            sessionId: "../../etc/passwd",
            cwd: "/work/site",
          }),
        },
      },
    });
    const sessions = new BoardScanner(system).scan().sessions;
    const of = (pid: number) => sessions.find((item) => item.pid === pid)!;
    expect(of(100)).toMatchObject({
      state: "working",
      since: start - 30 * minute,
      activeAt: start - 2 * minute,
    });
    expect(of(200)).toMatchObject({
      state: "working",
      activeAt: start - 7 * minute,
    });
    // An agent with no state reader has no time: the key is absent, and no stall is ever said.
    expect(of(300).state).toBe("unknown");
    expect("activeAt" in of(300)).toBe(false);
  });
});

describe("the watcher on the command line", () => {
  const cli = async (args: string[], directory: string, at = start) => {
    const lines: string[] = [];
    await agentsCli(args, {
      system: fakeSystem({
        now: at,
        env: { CLAWDTIME_CONFIG_HOME: directory, PATH: "/usr/bin" },
      }),
      print: (text) => lines.push(text),
      hookScript: "/x.js",
      isTTY: false,
      columns: 100,
    });
    return lines;
  };

  it("lists what is open and what happened, and says when no watcher runs", async () => {
    const directory = root();
    mkdirSync(directory, { recursive: true });
    expect(await cli(["incidents"], directory)).toEqual([
      "The watcher runs with the desktop service, and in: clawdtime agents watch. Neither runs now.",
    ]);
    const store = new WatchStore(directory);
    const { scan } = watching({ store });
    scan(start, [
      session({ since: start }),
      session({
        id: "2-b",
        pid: 2,
        name: "docs",
        since: start,
        activeAt: start,
      }),
    ]);
    scan(start + 3000, [
      session({
        id: "2-b",
        pid: 2,
        name: "docs",
        since: start,
        activeAt: start,
      }),
    ]);
    scan(start + 10 * minute, [
      session({
        id: "2-b",
        pid: 2,
        name: "docs",
        since: start,
        activeAt: start,
      }),
    ]);
    const at = start + 10 * minute + 5000;
    const stamp = `${new Date(start + 10 * minute).toISOString().slice(0, 16).replace("T", " ")}Z`;
    expect(await cli(["incidents"], directory, at)).toEqual([
      "  FAILED   deploy fix is gone: its process ended in the middle of its work.\n  STALLED  docs has shown no sign of life for 10m.",
      "Recent",
      // Newest first. The time is printed in UTC, so it reads the same on every Mac.
      `  ${stamp}  raised    deploy fix is gone: its process ended in the middle of its work.`,
      `  ${stamp}  raised    docs has shown no sign of life for 10m.`,
    ]);
    // The list of sessions shows what was found above the board.
    const list = await cli([], directory, at);
    expect(list[0]).toBe(
      "  FAILED   deploy fix is gone: its process ended in the middle of its work.\n  STALLED  docs has shown no sign of life for 10m.",
    );
    expect(list[1]).toBe("");
    expect(list[2]).toContain("Agents  no agent sessions");
    // --json stays the snapshot alone: other programs read it.
    const json = JSON.parse((await cli(["--json"], directory, at)).join("\n"));
    expect(Object.keys(json).sort()).toEqual([
      "counts",
      "generatedAt",
      "intervalMs",
      "sessions",
      "version",
    ]);
    const data = JSON.parse(
      (await cli(["incidents", "--json"], directory, at)).join("\n"),
    );
    expect(data.live).toBe(true);
    expect(data.open.map((item: { kind: string }) => item.kind)).toEqual([
      "failed",
      "stalled",
    ]);
    expect(data.recent).toHaveLength(2);
    // A minute after the watcher stopped, nothing is shown as current.
    expect((await cli([], directory, at + 2 * minute))[0]).toContain("Agents");
    // Names are data: no control character reaches the terminal.
    expect(
      renderIncidents(
        [{ ...store.readOpen(at).incidents[0]!, title: "bad\u001b[31m name" }],
        { color: false, now: at },
      ),
    ).not.toContain("\u001b");
  });

  it("prints and changes the rules", async () => {
    const directory = root();
    expect((await cli(["watch-rules"], directory)).join("\n")).toBe(
      renderRules(defaultRules),
    );
    expect(
      (await cli(["watch-rules", "set", "wait", "5m"], directory)).join("\n"),
    ).toContain("  wait      5m ");
    expect(new WatchStore(directory).rules().waitSeconds).toBe(300);
    await expect(
      cli(["watch-rules", "set", "wait", "10"], directory),
    ).rejects.toThrow("under 30 seconds");
    await expect(
      cli(["watch-rules", "set", "wait"], directory),
    ).rejects.toThrow("clawdtime agents watch-rules set");
    await expect(cli(["incidents", "extra"], directory)).rejects.toThrow(
      "Use: clawdtime agents incidents",
    );
  });
});

describe("the contract with the panel", () => {
  it("is one file that the service's schema and the panel's decoder both read", () => {
    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("./fixtures/agent-incidents.json", import.meta.url),
        ),
        "utf8",
      ),
    ) as { version: number; incidents: (Incident & { text: string })[] };
    expect(fixture.version).toBe(1);
    // The board fixture's own time: the sentences in the file are counted then.
    const at = 1795156200000;
    for (const { text, ...incident } of fixture.incidents) {
      const parsed = incidentSchema.parse(incident);
      expect(incidentSentence(parsed, at)).toBe(text);
    }
    expect(fixture.incidents.map((incident) => incident.kind)).toEqual([
      "failed",
      "waiting",
      "stalled",
      "finished",
    ]);
    // The view that the service sends has exactly these keys for each incident.
    expect(
      incidentsView(
        fixture.incidents.map(({ text: _text, ...incident }) => incident),
        at,
      ),
    ).toEqual(fixture);
  });
});
