import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentsCli } from "../cli/agents.js";
import {
  OpenAIModel,
  Supervisor,
  type ModelClient,
  type ModelMessage,
  type SupervisorWorld,
  type ToolCall,
} from "../connectors/agents/brain.js";
import { spokenQuestion } from "../connectors/agents/call.js";
import { DecisionDesk } from "../connectors/agents/decisions.js";
import { BoardFeed } from "../connectors/agents/feed.js";
import {
  looksSecret,
  Memory,
  memoryDirectory,
  terms,
} from "../connectors/agents/memory.js";
import { fakeSystem } from "./connectors-agents-fixture.js";

const start = new Date(2026, 10, 20, 12, 0, 0).getTime();
const day = 86_400_000;
const root = () => mkdtempSync(join(tmpdir(), "clawdtime-memory-"));
/** A memory with a clock that the test moves. */
function memory(directory = root()) {
  const clock = { now: start };
  const store = new Memory(directory, () => clock.now);
  store.setEnabled(true);
  return { store, clock, directory };
}
const factsFile = (directory: string) =>
  join(memoryDirectory(directory), "facts.json");

describe("memory", () => {
  it("is off until the person turns it on, and keeps its files for the owner only", () => {
    const directory = root();
    const store = new Memory(directory, () => start);
    expect(store.enabled()).toBe(false);
    expect(store.facts()).toEqual([]);
    expect(store.profile()).toBe("");
    // Reading an off memory makes no file.
    expect(existsSync(memoryDirectory(directory))).toBe(false);
    store.setEnabled(true);
    expect(store.enabled()).toBe(true);
    const settings = join(memoryDirectory(directory), "settings.json");
    expect(statSync(settings).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({
      version: 1,
      enabled: true,
    });
    store.setEnabled(false);
    expect(store.enabled()).toBe(false);
    // A settings file that cannot be read means off, never on.
    writeFileSync(settings, "{broken");
    expect(store.enabled()).toBe(false);
  });

  it("keeps a fact once: the same words again make it stronger and newer", () => {
    const { store, clock, directory } = memory();
    const first = store.remember({
      text: "  I prefer pnpm over npm. ",
      kind: "preference",
    });
    expect(first.added).toBe(true);
    expect(first.fact).toMatchObject({
      text: "I prefer pnpm over npm.",
      kind: "preference",
      scope: null,
      source: "said",
      strength: 1,
      current: true,
      replaces: null,
      extends: null,
      expiresAt: null,
      createdAt: start,
    });
    expect(first.fact.id).toMatch(/^[0-9a-f]{8}$/);
    clock.now += 3 * day;
    const again = store.remember({ text: "i prefer PNPM over npm" });
    expect(again.added).toBe(false);
    expect(again.fact).toMatchObject({
      id: first.fact.id,
      strength: 2,
      updatedAt: start + 3 * day,
      createdAt: start,
    });
    expect(store.facts()).toHaveLength(1);
    expect(statSync(factsFile(directory)).mode & 0o777).toBe(0o600);
    expect(() => store.remember({ text: "   " })).toThrow("needs some text");
    // The same words in a project are a fact of that project, not a copy to merge.
    expect(
      store.remember({ text: "I prefer pnpm over npm.", scope: "/work/app" })
        .added,
    ).toBe(true);
  });

  it("lets a newer fact replace an older one, and keeps the older one as history", () => {
    const { store } = memory();
    const old = store.remember({ text: "I work on the control plane." }).fact;
    const detail = store.remember({
      text: "The control plane runs on Vercel.",
      extends: old.id,
    }).fact;
    expect(detail.extends).toBe(old.id);
    const next = store.remember({
      text: "I work on the Mac fleet.",
      replaces: old.id,
    }).fact;
    expect(next.replaces).toBe(old.id);
    const all = store.facts();
    expect(all).toHaveLength(3);
    expect(all.find((fact) => fact.id === old.id)!.current).toBe(false);
    expect(
      store.search("what do I work on").map((found) => found.fact.id),
    ).toEqual([next.id]);
    expect(store.profile()).not.toContain("I work on the control plane.");
    // An id that is not there replaces nothing and links to nothing.
    const loose = store.remember({
      text: "I like dark mode.",
      replaces: "00000000",
      extends: "11111111",
    }).fact;
    expect(loose).toMatchObject({ replaces: null, extends: null });
  });

  it("lets an episode expire, and drops it from the file at the next write", () => {
    const { store, clock, directory } = memory();
    const demo = store.remember({
      text: "The demo is on Friday.",
      kind: "episode",
    }).fact;
    expect(demo.expiresAt).toBe(start + 14 * day);
    const short = store.remember({
      text: "The staging database is frozen.",
      days: 2,
    }).fact;
    expect(short).toMatchObject({ kind: "fact", expiresAt: start + 2 * day });
    store.remember({ text: "I deploy only on weekdays." });
    clock.now += 3 * day;
    expect(store.facts().map((fact) => fact.text)).toEqual([
      "The demo is on Friday.",
      "I deploy only on weekdays.",
    ]);
    expect(store.search("staging database")).toEqual([]);
    clock.now += 12 * day;
    expect(store.search("demo Friday")).toEqual([]);
    expect(readFileSync(factsFile(directory), "utf8")).toContain("demo");
    store.remember({ text: "I use Ghostty." });
    const kept = readFileSync(factsFile(directory), "utf8");
    expect(kept).not.toContain("demo");
    expect(kept).not.toContain("staging");
    expect(kept).toContain("weekdays");
  });

  it("refuses anything shaped like a credential", () => {
    const { store, directory } = memory();
    for (const text of [
      "my key is sk-abcdefghijklmnopqrstuv",
      "use AKIAABCDEFGHIJKLMNOP for the bucket",
      `the token is ghp_${"a1".repeat(15)}`,
      "slack: xoxb-123456789012-abcdef",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "password: hunter2222",
      "api_key = 9f8e7d6c5b4a",
      "TOKEN=abcd1234efgh",
    ]) {
      expect(looksSecret(text)).toBe(true);
      expect(() => store.remember({ text })).toThrow("credential");
    }
    expect(existsSync(factsFile(directory))).toBe(false);
    // Talk about secrets is not a secret.
    for (const text of [
      "The token budget for a prompt is small.",
      "My password policy: rotate every 90 days.",
      "Keep the secret: surprise party on Friday.",
    ])
      expect(looksSecret(text)).toBe(false);
  });

  it("finds by words, and respects the threshold, the project and what is current", () => {
    const { store } = memory();
    expect(terms("Pushes pushed pushing push the notes")).toEqual([
      "push",
      "note",
    ]);
    const push = store.remember({ text: "Never force push to main." }).fact;
    const pnpm = store.remember({
      text: "Use pnpm in this project.",
      scope: "/work/app",
    }).fact;
    store.remember({ text: "Use yarn in this project.", scope: "/work/other" });
    const tabs = store.remember({ text: "I prefer tabs." }).fact;
    const spaces = store.remember({
      text: "I prefer two spaces.",
      replaces: tabs.id,
    }).fact;
    const found = store.search("git push origin main", { scope: "/work/app" });
    expect(found[0]!.fact.id).toBe(push.id);
    expect(found[0]!.score).toBeGreaterThanOrEqual(0.3);
    expect(found[0]!.score).toBeLessThanOrEqual(1);
    expect(store.search("pushing to main")[0]!.fact.id).toBe(push.id);
    // One shared common word is a weak match: nothing comes back.
    expect(store.search("git push origin feature-branch")).toEqual([]);
    expect(store.search("git status")).toEqual([]);
    expect(store.search("the of and")).toEqual([]);
    // A project sees its own facts and the person's. Never another project's.
    const ids = (query: string, scope?: string | null) =>
      store
        .search(query, scope === undefined ? {} : { scope })
        .map((item) => item.fact.id);
    expect(ids("pnpm install lodash", "/work/app")).toEqual([pnpm.id]);
    expect(ids("pnpm install lodash", "/work/other")).toEqual([]);
    expect(ids("pnpm install lodash", null)).toEqual([]);
    expect(ids("pnpm install lodash")).toEqual([pnpm.id]);
    // What was replaced is history: it is not found.
    expect(ids("tabs")).toEqual([]);
    expect(ids("two spaces")).toEqual([spaces.id]);
    expect(store.search("push main", { limit: 1 })).toHaveLength(1);
    expect(store.search("push main", { threshold: 0.99 })).toEqual([]);
  });

  it("gives a small profile: what lasts, strongest first, then what is recent", () => {
    const { store, clock } = memory();
    for (let index = 0; index < 14; index++)
      store.remember({ text: `Lasting fact number ${index} about the work.` });
    store.remember({ text: "I prefer pnpm over npm.", kind: "preference" });
    store.remember({ text: "I prefer pnpm over npm." });
    store.remember({ text: "I prefer pnpm over npm." });
    store.remember({
      text: "The person likes short answers.",
      source: "inferred",
    });
    store.remember({ text: "Only for the app.", scope: "/work/app" });
    clock.now += 10 * day;
    for (let index = 0; index < 8; index++)
      store.remember({
        text: `Episode ${index}: something that happened this week.`,
        kind: "episode",
      });
    const profile = store.profile();
    const lines = profile.split("\n");
    expect(lines[0]).toBe("- I prefer pnpm over npm.");
    expect(lines.indexOf("Recent:")).toBe(10);
    expect(lines.slice(11)).toHaveLength(6);
    expect(lines.slice(11).every((line) => line.startsWith("- Episode"))).toBe(
      true,
    );
    expect(profile.length).toBeLessThanOrEqual(1200);
    // A long memory still gives a short profile.
    const big = memory();
    for (let index = 0; index < 40; index++)
      big.store.remember({ text: `${"long words ".repeat(30)}${index}` });
    expect(big.store.profile().length).toBeLessThanOrEqual(1200);
    expect(big.store.profile().split("\n")).toHaveLength(10);
    // An inferred line is marked. A project fact shows only for that project.
    const small = memory();
    small.store.remember({ text: "Likes short answers.", source: "inferred" });
    small.store.remember({ text: "Only for the app.", scope: "/work/app" });
    expect(small.store.profile(null)).toBe("- Likes short answers. (inferred)");
    expect(small.store.profile("/work/app")).toContain("- Only for the app.");
    expect(small.store.profile("/work/other")).not.toContain(
      "Only for the app",
    );
  });

  it("forgets for good, by id or by words", () => {
    const { store, directory } = memory();
    const old = store.remember({ text: "I work on the control plane." }).fact;
    const next = store.remember({
      text: "I work on the Mac fleet.",
      replaces: old.id,
    }).fact;
    store.remember({ text: "Use pnpm in this project." });
    store.remember({ text: "pnpm is faster than npm." });
    expect(store.forget(old.id)).toBe(1);
    // A link to a fact that is gone is cleared.
    expect(store.facts().find((fact) => fact.id === next.id)!.replaces).toBe(
      null,
    );
    expect(store.forget("PNPM")).toBe(2);
    expect(readFileSync(factsFile(directory), "utf8")).not.toContain("pnpm");
    expect(store.forget("pnpm")).toBe(0);
    expect(store.forget("zz")).toBe(0);
    expect(store.facts().map((fact) => fact.text)).toEqual([
      "I work on the Mac fleet.",
    ]);
  });

  it("reports a damaged file and never overwrites it, and refuses a link", () => {
    const { store, directory } = memory();
    mkdirSync(memoryDirectory(directory), { recursive: true });
    writeFileSync(factsFile(directory), "{not json");
    expect(() => store.facts()).toThrow("damaged");
    expect(() => store.remember({ text: "I use Ghostty." })).toThrow("damaged");
    expect(readFileSync(factsFile(directory), "utf8")).toBe("{not json");
    // One bad row among good ones is skipped.
    const other = memory();
    const good = other.store.remember({ text: "I use Ghostty." }).fact;
    writeFileSync(
      factsFile(other.directory),
      JSON.stringify([good, { id: "nope" }]),
    );
    expect(other.store.facts().map((fact) => fact.id)).toEqual([good.id]);
    const linked = root();
    mkdirSync(memoryDirectory(linked), { recursive: true });
    writeFileSync(join(linked, "elsewhere.json"), "[]");
    symlinkSync(join(linked, "elsewhere.json"), factsFile(linked));
    expect(() => new Memory(linked).facts()).toThrow("not a regular file");
  });
});

/** A model that follows a script and records what it was given. */
function scripted(steps: (ToolCall[] | string | Error)[]) {
  const seen: { system: string; messages: ModelMessage[]; tools: string[] }[] =
    [];
  let step = 0;
  const model: ModelClient = {
    async complete(input) {
      seen.push({
        system: input.system,
        messages: structuredClone(input.messages),
        tools: input.tools.map((tool) => tool.name),
      });
      const next = steps[Math.min(step++, steps.length - 1)]!;
      if (next instanceof Error) throw next;
      return typeof next === "string"
        ? { text: next, toolCalls: [] }
        : { text: "", toolCalls: next };
    },
  };
  return { model, seen };
}
const call = (name: string, args: unknown, id = `c-${name}`): ToolCall => ({
  id,
  name,
  arguments: JSON.stringify(args),
});
function world(directory = root()) {
  const desk = new DecisionDesk(directory, () => start);
  const value: SupervisorWorld = {
    now: () => start,
    board: () => null,
    desk,
    focus: async () => ({ ok: false }),
    send: async () => ({ ok: false, route: "none" }),
    clis: () => [],
  };
  return { value, desk, directory };
}
const lastTool = (run: ReturnType<typeof scripted>, turn = 1) =>
  run.seen[turn]!.messages.at(-1)!.content;

describe("memory and the ClawdTime agent", () => {
  it("shows the agent what it knows, and the memory tools, only while memory is on", async () => {
    const { value, desk } = world();
    desk.memory.setEnabled(true);
    desk.memory.remember({ text: "I prefer pnpm over npm." });
    desk.memory.setEnabled(false);
    // Off: no block, no tools, and a memory tool does not exist.
    let run = scripted([[call("remember", { text: "x y z" })], "ok"]);
    await new Supervisor(value, run.model).reply(
      [],
      "remember that x y z",
      "chat",
    );
    expect(run.seen[0]!.system).not.toContain("What you know");
    expect(run.seen[0]!.system).not.toContain("pnpm");
    expect(run.seen[0]!.tools).not.toContain("remember");
    expect(run.seen[0]!.tools).not.toContain("recall");
    expect(lastTool(run)).toBe("There is no such tool.");
    expect(desk.memory.facts()).toHaveLength(1);
    // Off also means that nothing is asked of the model after the answer.
    expect(run.seen).toHaveLength(2);
    desk.memory.setEnabled(true);
    run = scripted(["You like pnpm."]);
    await new Supervisor(value, run.model).reply([], "hi", "chat");
    expect(run.seen[0]!.system).toContain(
      "What you know about this person, from memory (a line marked inferred is a guess):\n- I prefer pnpm over npm.",
    );
    expect(run.seen[0]!.tools.slice(-3)).toEqual([
      "remember",
      "recall",
      "forget",
    ]);
    // An empty memory adds no block.
    const empty = world();
    empty.desk.memory.setEnabled(true);
    run = scripted(["Hello."]);
    await new Supervisor(empty.value, run.model).reply([], "hi", "chat");
    expect(run.seen[0]!.system).not.toContain("What you know");
    expect(run.seen[0]!.tools).toContain("recall");
  });

  it("keeps the person's own words, recalls them, and forgets only when the person asks", async () => {
    const { value, desk } = world();
    desk.memory.setEnabled(true);
    // The model rewords it: the person's sentence is kept.
    let run = scripted([
      [call("remember", { text: "Prefers concise commit subjects always" })],
      "Kept.",
    ]);
    await new Supervisor(value, run.model).reply(
      [],
      "remember I like short commit messages",
      "chat",
    );
    expect(lastTool(run)).toBe("Kept in memory.");
    expect(desk.memory.facts()[0]).toMatchObject({
      text: "remember I like short commit messages",
      source: "said",
      kind: "fact",
    });
    // The model keeps to the person's words: its shorter text is stored.
    run = scripted([
      [
        call("remember", {
          text: "I deploy only on weekdays",
          kind: "preference",
        }),
      ],
      "Kept.",
    ]);
    await new Supervisor(value, run.model).reply(
      [],
      "note this: I deploy only on weekdays",
      "voice",
    );
    expect(desk.memory.facts()[1]).toMatchObject({
      text: "I deploy only on weekdays",
      kind: "preference",
    });
    run = scripted([[call("recall", { query: "deploy weekdays" })], "ok"]);
    await new Supervisor(value, run.model).reply(
      [],
      "when do I deploy?",
      "chat",
    );
    expect(lastTool(run)).toBe(
      `${desk.memory.facts()[1]!.id} I deploy only on weekdays`,
    );
    run = scripted([[call("recall", { query: "kubernetes" })], "ok"]);
    await new Supervisor(value, run.model).reply([], "k8s?", "chat");
    expect(lastTool(run)).toBe("Nothing in memory matches.");
    // The model tries to forget on its own: refused.
    run = scripted([[call("forget", { what: "weekdays" })], "ok"]);
    await new Supervisor(value, run.model).reply(
      [],
      "when do I deploy?",
      "chat",
    );
    expect(lastTool(run)).toBe("The person did not ask to forget. Ask them.");
    expect(desk.memory.facts()).toHaveLength(2);
    run = scripted([
      [
        call("forget", { what: "weekdays" }),
        call("forget", { what: "nothing like this" }, "c-2"),
      ],
      "Gone.",
    ]);
    await new Supervisor(value, run.model).reply(
      [],
      "forget what I said about weekdays",
      "chat",
    );
    expect(
      run.seen[1]!.messages.filter((message) => message.role === "tool").map(
        (message) => message.content,
      ),
    ).toEqual(["Removed 1 from memory.", "Nothing in memory matches that."]);
    expect(desk.memory.facts()).toHaveLength(1);
    // A credential is refused with the reason, and nothing is stored.
    run = scripted([
      [call("remember", { text: "password: hunter2222" })],
      "I cannot keep that.",
    ]);
    await new Supervisor(value, run.model).reply(
      [],
      "remember password: hunter2222",
      "chat",
    );
    expect(lastTool(run)).toContain("credential");
    expect(desk.memory.facts()).toHaveLength(1);
  });

  it("writes what a message taught after the answer, and a failure there changes nothing", async () => {
    const { value, desk } = world();
    desk.memory.setEnabled(true);
    const known = desk.memory.remember({
      text: "I work on the control plane.",
    }).fact;
    const said =
      "I work on the Mac fleet now. I deploy only on weekdays, and the launch is next Tuesday.";
    let run = scripted([
      "Understood.",
      `Here you go:\n${JSON.stringify([
        { text: "I work on the Mac fleet now", replaces: known.id },
        { text: "The person avoids weekend deployments", kind: "preference" },
        { text: "the launch is next Tuesday", kind: "episode", days: 5 },
        { text: "A fourth line is one too many", kind: "fact" },
      ])}`,
    ]);
    let supervisor = new Supervisor(value, run.model);
    expect(await supervisor.reply([], said, "chat")).toBe("Understood.");
    await supervisor.learning;
    // The second question has no tools, the known facts and the person's words.
    expect(run.seen).toHaveLength(2);
    expect(run.seen[1]!.tools).toEqual([]);
    expect(run.seen[1]!.system).toContain("Answer with JSON only");
    expect(run.seen[1]!.messages[0]!.content).toBe(
      `Known facts:\n${known.id} I work on the control plane.\n\nThe person said:\n${said}`,
    );
    const facts = desk.memory.facts();
    expect(facts).toHaveLength(4);
    expect(facts[0]).toMatchObject({ id: known.id, current: false });
    expect(facts[1]).toMatchObject({
      text: "I work on the Mac fleet now",
      source: "said",
      replaces: known.id,
      current: true,
    });
    // Words that the person did not say are the model's: the fact is marked.
    expect(facts[2]).toMatchObject({ source: "inferred", kind: "preference" });
    expect(facts[3]).toMatchObject({
      source: "said",
      kind: "episode",
      expiresAt: start + 5 * day,
    });
    // A short message, such as a plain yes, asks nothing more of the model.
    run = scripted(["Allowed."]);
    supervisor = new Supervisor(value, run.model);
    await supervisor.reply([], "yes approve it", "chat");
    await supervisor.learning;
    expect(run.seen).toHaveLength(1);
    // The second question fails, or answers with no list, or with a broken one.
    for (const second of [
      new Error("offline"),
      "Nothing to keep.",
      "[{",
      '[{"text":"password: hunter2222"}]',
      '{"text":"not a list at all here"}',
    ]) {
      run = scripted(["Fine.", second]);
      supervisor = new Supervisor(value, run.model);
      expect(
        await supervisor.reply(
          [],
          "this is a longer message about nothing much",
          "chat",
        ),
      ).toBe("Fine.");
      await expect(supervisor.learning).resolves.toBeUndefined();
      expect(run.seen).toHaveLength(2);
    }
    expect(desk.memory.facts()).toHaveLength(4);
  });

  it("sends the model no tool list when there are no tools", async () => {
    const bodies: Record<string, unknown>[] = [];
    const request = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "[]" } }] }),
      );
    }) as typeof fetch;
    const model = new OpenAIModel("sk-test", "model-x", request);
    await model.complete({ system: "s", messages: [], tools: [] });
    expect("tools" in bodies[0]!).toBe(false);
    await model.complete({
      system: "s",
      messages: [],
      tools: [{ name: "status", description: "d", parameters: {} }],
    });
    expect(bodies[1]!.tools).toHaveLength(1);
  });
});

describe("memory on a waiting request, in the panel and in the command", () => {
  const ask = (desk: DecisionDesk, cwd = "/work/app") =>
    desk.open({
      agent: "claude-code",
      sessionId: "s",
      cwd,
      pids: [],
      described: {
        kind: "permission",
        tool: "Bash",
        summary: "git push origin main",
        options: [],
      },
      holdSeconds: 45,
    });

  it("shows what the person said before on the request, only with memory on", () => {
    const directory = root();
    const feed = new BoardFeed({
      root: directory,
      now: () => start,
      model: null,
      speech: null,
    });
    const request = ask(feed.desk);
    expect(feed.chat().memory).toBe(false);
    expect(feed.decisions().pending[0]!.recalled).toBeNull();
    feed.setMemory(true);
    expect(feed.chat().memory).toBe(true);
    expect(feed.decisions().pending[0]!.recalled).toBeNull();
    feed.desk.memory.remember({
      text: "Use yarn in this project.",
      scope: "/work/other",
    });
    feed.desk.memory.remember({ text: "Never force push to main." });
    expect(feed.decisions().pending[0]!.recalled).toBe(
      "Never force push to main.",
    );
    // The same words go into the question that a call speaks.
    expect(spokenQuestion(request, feed.desk.recalled(request))).toBe(
      "Claude Code in app asks to run the command: git push origin main. You said before: Never force push to main. Say approve or deny.",
    );
    expect(spokenQuestion(request)).toBe(
      "Claude Code in app asks to run the command: git push origin main. Say approve or deny.",
    );
    feed.setMemory(false);
    expect(feed.decisions().pending[0]!.recalled).toBeNull();
    expect(feed.desk.recalled(request)).toBeNull();
    // A damaged memory file never breaks the list of requests.
    feed.setMemory(true);
    writeFileSync(factsFile(directory), "{broken");
    expect(feed.decisions().pending[0]!.recalled).toBeNull();
  });

  it("has a command for every step: status, on, remember, show, search, forget, off", async () => {
    const directory = realpathSync(root());
    const lines: string[] = [];
    const run = (...args: string[]) =>
      agentsCli(args, {
        system: fakeSystem({
          now: start,
          env: { CLAWDTIME_CONFIG_HOME: directory },
        }),
        print: (line) => lines.push(line),
        hookScript: "/x/agent-hook.js",
      });
    const top = (...args: string[]) => run("--supervisor", "memory", ...args);
    await top();
    expect(lines.at(-1)).toBe(
      "Memory is off. 0 facts kept. Turn it on: clawdtime memory on",
    );
    // Off: nothing is written, also not by hand.
    await expect(top("remember", "I", "prefer", "pnpm")).rejects.toThrow(
      "Memory is off",
    );
    expect(existsSync(factsFile(directory))).toBe(false);
    await top("on");
    expect(lines.at(-1)).toContain("Memory is on");
    await top("remember", "Never", "force", "push", "to", "main.");
    expect(lines.at(-1)).toMatch(/^Kept \([0-9a-f]{8}\)\.$/);
    await top("remember", "never force push to main");
    expect(lines.at(-1)).toContain("Known already");
    await top(
      "remember",
      "Use pnpm here.",
      "--kind",
      "preference",
      "--project",
      directory,
    );
    await top(
      "remember",
      "The demo is on Friday.",
      "--kind",
      "episode",
      "--days",
      "3",
    );
    await expect(top("remember", "x y", "--kind", "wish")).rejects.toThrow(
      "Use --kind",
    );
    await expect(top("remember", "password: hunter2222")).rejects.toThrow(
      "credential",
    );
    await top("status");
    expect(lines.at(-1)).toBe("Memory is on. 3 facts kept.");
    const before = lines.length;
    await top("show");
    const shown = lines.slice(before).join("\n");
    expect(shown).toContain("x2 Never force push to main.");
    expect(shown).toContain(`[${directory.split("/").at(-1)}] Use pnpm here.`);
    expect(shown).toContain("The demo is on Friday.  (until 2026-11-23)");
    await top("search", "git", "push", "origin", "main");
    expect(lines.at(-1)).toMatch(
      /^[0-9a-f]{8} {2}0\.\d\d {2}Never force push to main\.$/,
    );
    await top("search", "kubernetes");
    expect(lines.at(-1)).toBe("Nothing in memory matches.");
    // The pending list says what the person said before about a request.
    const desk = new DecisionDesk(directory, () => start);
    desk.attend();
    ask(desk, "/work/app");
    await run("pending");
    expect(lines.at(-1)).toBe(
      "     you said before: Never force push to main.",
    );
    await top("forget", "demo");
    expect(lines.at(-1)).toBe("Removed 1 fact for good.");
    await top("forget", "nothing like this");
    expect(lines.at(-1)).toContain("Nothing in memory matches");
    process.exitCode = 0;
    await top("off");
    expect(lines.at(-1)).toContain("Memory is off");
    await run("pending");
    expect(lines.at(-1)).not.toContain("you said before");
    await expect(top("dance")).rejects.toThrow("Use: clawdtime memory");
  });
});
