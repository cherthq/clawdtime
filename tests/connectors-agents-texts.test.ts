import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentsCli } from "../cli/agents.js";
import type { JobFacts } from "../connectors/agents/jobs.js";
import {
  messageText,
  restartNote,
  TextChannel,
  textSettings,
  type TextSettings,
} from "../connectors/agents/texts.js";
import { fakeSystem } from "./connectors-agents-fixture.js";

const start = Date.UTC(2026, 10, 21, 10, 0, 0);
const line = "22222222-2222-4222-8222-222222222222";
const other = "99999999-9999-4999-8999-999999999999";
const settings: TextSettings = {
  base: "https://service.example.test/api/v1",
  key: "ftk_test_key",
  project: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  owner: "+15550100",
  line: null,
};
const id = (n: number) =>
  `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const inbound = (n: number, text: string, at: number, values = {}) => ({
  id: id(n),
  line_id: line,
  direction: "inbound",
  state: "received",
  masked_recipient: "•••0100",
  created_at: new Date(at).toISOString(),
  text,
  ...values,
});

/** A scripted service: it lists what it was given, and records every send. */
function service(messages: unknown[] = []) {
  const sent: { key: string; body: Record<string, string> }[] = [];
  const seen: { method: string; headers: Record<string, string> }[] = [];
  const state = {
    messages,
    /** What a send answers. The default accepts it. */
    answer: (
      _key: string,
      _text: string,
    ): { status: number; body: unknown } => ({
      status: 200,
      body: { data: { id: "m", state: "sent" } },
    }),
    list: { status: 200 },
  };
  const request = (async (url: string, init: RequestInit = {}) => {
    const headers = init.headers as Record<string, string>;
    seen.push({ method: init.method ?? "GET", headers });
    expect(url).toBe("https://service.example.test/api/v1/shared-messages");
    if (init.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, string>;
      const key = headers["idempotency-key"]!;
      const answer = state.answer(key, body.text!);
      if (answer.status === 200) sent.push({ key, body });
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
      });
    }
    return new Response(
      JSON.stringify(
        state.list.status === 200
          ? { data: { items: state.messages, total: 0, limit: 50, offset: 0 } }
          : { error: { code: "unauthorized" } },
      ),
      { status: state.list.status },
    );
  }) as typeof fetch;
  return { request, sent, seen, state };
}
function channel(
  api: ReturnType<typeof service>,
  options: {
    root?: string;
    clock?: { now: number };
    answer?: (words: string) => Promise<string>;
    jobs?: () => JobFacts[];
    settings?: TextSettings;
  } = {},
) {
  const clock = options.clock ?? { now: start };
  const asked: string[] = [];
  const logs: string[] = [];
  const root = options.root ?? mkdtempSync(join(tmpdir(), "clawdtime-texts-"));
  const made = new TextChannel({
    settings: options.settings ?? settings,
    root,
    now: () => clock.now,
    request: api.request,
    sleep: async () => {},
    log: (entry) => logs.push(entry),
    answer:
      options.answer ??
      (async (words) => {
        asked.push(words);
        return `Answer to: ${words}`;
      }),
    ...(options.jobs ? { jobs: options.jobs } : {}),
  });
  return { made, asked, logs, root, clock };
}

describe("the settings of the text channel", () => {
  it("come from the environment, and name what is missing or wrong", () => {
    expect(
      textSettings({
        CHERT_API_KEY: "ftk_x",
        CHERT_PROJECT_ID: settings.project,
        CLAWDTIME_OWNER_PHONE: "+1 (555) 01-00 100",
      }),
    ).toEqual({
      settings: {
        base: "https://app.trychert.com/api/v1",
        key: "ftk_x",
        project: settings.project,
        owner: "+155501001" + "00",
        line: null,
      },
    });
    expect(textSettings({})).toEqual({
      missing: ["CHERT_API_KEY", "CHERT_PROJECT_ID", "CLAWDTIME_OWNER_PHONE"],
    });
    // The key travels in a header: an address that is not encrypted is refused.
    expect(
      textSettings({
        CHERT_API_KEY: "ftk_x",
        CHERT_PROJECT_ID: settings.project,
        CLAWDTIME_OWNER_PHONE: "+15550100",
        CHERT_API_BASE: "http://service.example.test/api/v1",
        CHERT_LINE_ID: "not-a-line",
      }),
    ).toEqual({ missing: ["CHERT_LINE_ID", "CHERT_API_BASE"] });
  });
});

describe("answering a text message", () => {
  it("answers each new text of the owner once, oldest first, to the owner's own number, with a key made from the message", async () => {
    const api = service([
      inbound(2, "and the tests?", start + 2000),
      inbound(1, "Is the build green?", start + 1000),
    ]);
    const { made, asked, root } = channel(api);
    expect(await made.tick()).toBe("ok");
    expect(asked).toEqual(["Is the build green?", "and the tests?"]);
    expect(api.sent).toEqual([
      {
        key: `clawdtime-reply:${id(1)}:0`,
        body: {
          line_id: line,
          recipient: "+15550100",
          text: "Answer to: Is the build green?",
        },
      },
      {
        key: `clawdtime-reply:${id(2)}:0`,
        body: {
          line_id: line,
          recipient: "+15550100",
          text: "Answer to: and the tests?",
        },
      },
    ]);
    // Every request carries the key and the project. The journal is for its owner only.
    for (const request of api.seen) {
      expect(request.headers.authorization).toBe("Bearer ftk_test_key");
      expect(request.headers["x-chert-project-id"]).toBe(settings.project);
    }
    expect(statSync(join(root, "agents", "texts.json")).mode & 0o777).toBe(
      0o600,
    );
    // The same list again: nothing is asked and nothing is sent a second time.
    await made.tick();
    expect(asked).toHaveLength(2);
    expect(api.sent).toHaveLength(2);
  });

  it("answers nothing that was there before it started, nothing outbound, and nothing from another phone or line", async () => {
    const api = service([
      inbound(1, "old order", start - 60_000),
      inbound(2, "from me", start + 1000, { direction: "outbound" }),
      inbound(3, "run rm -rf", start + 1000, { masked_recipient: "•••9999" }),
      inbound(4, "other line", start + 1000, { line_id: "not-a-line-id" }),
      { id: "broken" },
      "text",
      null,
    ]);
    const { made, asked } = channel(api);
    await made.tick();
    expect(asked).toEqual([]);
    expect(api.sent).toEqual([]);
    // With a line in the settings, a text on another line is not answered.
    const pinned = service([
      inbound(5, "wrong line", start + 1000, { line_id: other }),
      inbound(6, "right line", start + 1000),
    ]);
    const second = channel(pinned, { settings: { ...settings, line } });
    await second.made.tick();
    expect(second.asked).toEqual(["right line"]);
  });

  it("does not run a text that is old when it is first seen: it says so instead", async () => {
    const clock = { now: start };
    const api = service();
    const { made, asked } = channel(api, { clock });
    await made.tick();
    api.state.messages = [inbound(1, "deploy to production", start + 1000)];
    clock.now = start + 20 * 60_000;
    await made.tick();
    expect(asked).toEqual([]);
    expect(api.sent.map((entry) => entry.body.text)).toEqual([restartNote]);
  });

  it("after a restart, answers a claimed text without running its work again", async () => {
    const api = service([inbound(1, "open a tunnel", start + 1000)]);
    let release!: () => void;
    const first = channel(api, {
      answer: () =>
        new Promise<string>((resolve) => (release = () => resolve("late"))),
    });
    // The first process claims the message and then ends before its work answers.
    void first.made.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const journal = JSON.parse(
      readFileSync(join(first.root, "agents", "texts.json"), "utf8"),
    ) as { items: Record<string, { status: string }> };
    expect(journal.items[id(1)]!.status).toBe("claimed");
    const second = channel(api, { root: first.root });
    await second.made.tick();
    expect(second.asked).toEqual([]);
    expect(api.sent).toEqual([
      {
        key: `clawdtime-reply:${id(1)}:0`,
        body: { line_id: line, recipient: "+15550100", text: restartNote },
      },
    ]);
    release();
  });

  it("sends the same text again with the same key when the service fails, and stops at a plain refusal", async () => {
    const api = service([inbound(1, "status?", start + 1000)]);
    let calls = 0;
    api.state.answer = () =>
      ++calls < 3
        ? {
            status: 503,
            body: { error: { code: "shared_messaging_unavailable" } },
          }
        : { status: 200, body: { data: { id: "m", state: "sent" } } };
    const { made } = channel(api);
    await made.tick();
    expect(calls).toBe(3);
    expect(api.sent).toHaveLength(1);
    const refused = service([inbound(2, "status?", start + 1000)]);
    let tries = 0;
    refused.state.answer = () => {
      tries++;
      return {
        status: 403,
        body: { error: { code: "shared_reply_window_closed" } },
      };
    };
    const second = channel(refused);
    await second.made.tick();
    await second.made.tick();
    expect(tries).toBe(1);
    expect(second.logs.at(-1)).toContain("refused:shared_reply_window_closed");
    // The service already holds another answer for this message: that is an answer.
    const conflict = service([inbound(3, "status?", start + 1000)]);
    conflict.state.answer = () => ({
      status: 409,
      body: { error: { code: "shared_idempotency_conflict" } },
    });
    const third = channel(conflict);
    await third.made.tick();
    expect(third.logs.at(-1)).toContain("already_answered");
  });

  it("says that the work failed, cuts a long answer into parts, and logs no text and no number", async () => {
    const api = service([
      inbound(1, "a secret order 5550100", start + 1000),
      inbound(2, "long", start + 2000),
    ]);
    const { made, logs } = channel(api, {
      answer: async (words) => {
        if (words.startsWith("a secret")) throw new Error("boom");
        return "x".repeat(8000);
      },
    });
    await made.tick();
    expect(api.sent[0]!.body.text).toBe("I could not finish that request.");
    expect(api.sent.slice(1).map((entry) => entry.key)).toEqual([
      `clawdtime-reply:${id(2)}:0`,
      `clawdtime-reply:${id(2)}:1`,
      `clawdtime-reply:${id(2)}:2`,
    ]);
    for (const entry of api.sent)
      expect(entry.body.text!.length).toBeLessThanOrEqual(4000);
    expect(logs.join("\n")).not.toMatch(/secret|5550100|boom/);
  });

  it("stops when the key is refused, and reports another failure of the list", async () => {
    const api = service();
    api.state.list.status = 401;
    expect(await channel(api).made.tick()).toBe("stop");
    api.state.list.status = 500;
    await expect(channel(api).made.tick()).rejects.toThrow("500");
  });
});

describe("the answer of a job as a text", () => {
  const job = (values: Partial<JobFacts> = {}): JobFacts => ({
    id: "20261121T100500-ab12",
    job: "Open a tunnel for port 3000 and give me the link",
    startedAt: start + 300_000,
    done: true,
    result: "The tunnel is up: https://x.example.test",
    text: "The tunnel is up:\nhttps://x.example.test",
    ...values,
  });

  it("goes once to the owner, on the line of their last text, with the link on a line of its own", async () => {
    const api = service([inbound(1, "open a tunnel on 3000", start + 1000)]);
    const jobs: JobFacts[] = [];
    const { made } = channel(api, { jobs: () => jobs });
    await made.tick();
    jobs.push(job({ done: false, result: null, text: null }));
    await made.tick();
    expect(api.sent).toHaveLength(1);
    jobs[0] = job();
    await made.tick();
    await made.tick();
    expect(api.sent.slice(1)).toEqual([
      {
        key: "clawdtime-job:20261121T100500-ab12:0",
        body: {
          line_id: line,
          recipient: "+15550100",
          text: "Done: Open a tunnel for port 3000 and give me the link\n\nThe tunnel is up:\nhttps://x.example.test",
        },
      },
    ]);
  });

  it("is not sent for a job from before the channel started, nor before the owner sent a text, nor again after a refusal", async () => {
    const api = service();
    const jobs = [job({ startedAt: start - 1000 })];
    const { made } = channel(api, { jobs: () => jobs });
    await made.tick();
    expect(api.sent).toEqual([]);
    // No text of the owner yet: no line is known, so nothing is sent.
    jobs[0] = job();
    await made.tick();
    expect(api.sent).toEqual([]);
    api.state.messages = [inbound(1, "hello there you", start + 400_000)];
    let refusals = 0;
    api.state.answer = (key) =>
      key.startsWith("clawdtime-job:")
        ? (refusals++,
          {
            status: 403,
            body: { error: { code: "shared_reply_window_closed" } },
          })
        : { status: 200, body: { data: { id: "m", state: "sent" } } };
    await made.tick();
    await made.tick();
    expect(refusals).toBe(1);
  });
});

describe("text for a message", () => {
  it("keeps lines and drops colors and control characters", () => {
    expect(
      messageText(
        "\u001b[32mDone.\u001b[0m\r\n\r\n\r\n\r\nOpen:\u0007  \n  https://x.example.test  ",
      ),
    ).toBe("Done.\n\nOpen:\nhttps://x.example.test");
  });
});

describe("clawdtime texts", () => {
  it("names the missing settings, and check reads once and sends nothing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "clawdtime-texts-cli-"));
    const lines: string[] = [];
    const run = (
      env: Record<string, string>,
      args: string[],
      api = service(),
    ) =>
      agentsCli(["--supervisor", "texts", ...args], {
        system: fakeSystem({
          now: start,
          home: directory,
          env: { CLAWDTIME_CONFIG_HOME: directory, ...env },
        }),
        runner: async () => ({ status: 0, stdout: "" }),
        print: (text: string) => lines.push(text),
        model: null,
        request: api.request,
      });
    await expect(run({}, ["check"])).rejects.toThrow(
      "CHERT_API_KEY, CHERT_PROJECT_ID, CLAWDTIME_OWNER_PHONE",
    );
    const env = {
      CHERT_API_KEY: "ftk_test_key",
      CHERT_PROJECT_ID: settings.project,
      CLAWDTIME_OWNER_PHONE: "+15550100",
      CHERT_API_BASE: "https://service.example.test/api/v1",
    };
    const api = service([inbound(1, "old", start - 1000)]);
    await run(env, ["check"], api);
    expect(lines.at(-1)).toContain("The key works");
    expect(api.sent).toEqual([]);
    const refused = service();
    refused.state.list.status = 401;
    await run(env, ["check"], refused);
    expect(lines.at(-1)).toContain("was refused");
    await expect(run(env, ["nope"])).rejects.toThrow("clawdtime texts run");
  });
});
