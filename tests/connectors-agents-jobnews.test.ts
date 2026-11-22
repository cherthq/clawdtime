import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChatLog, type ChatMessage } from "../connectors/agents/brain.js";
import { BoardFeed } from "../connectors/agents/feed.js";
import { JobNews, questionHoldMs } from "../connectors/agents/jobnews.js";
import { Jobs } from "../connectors/agents/jobs.js";
import { fakeSystem } from "./connectors-agents-fixture.js";

const start = Date.UTC(2026, 10, 21, 9, 0, 0);

/** A state folder with real job files and no real window, a chat log, and the news of that chat. */
function chat() {
  const root = mkdtempSync(join(tmpdir(), "clawdtime-jobnews-"));
  const clock = { now: start };
  const jobs = new Jobs(root, {
    project: "/work/app",
    now: () => clock.now,
    run: async () => ({ status: 0, stdout: "", stderr: "" }),
  });
  const log = new ChatLog(root);
  const news = () =>
    new JobNews(root, {
      jobs: () => jobs.recent(20),
      log,
      now: () => clock.now,
    });
  const folder = join(root, "agents", "jobs");
  /** Writes the answer of the newest job, or of the job at that place from the start. */
  const finish = (answer: string, at = -1) => {
    const ids = readdirSync(folder)
      .filter((name) => name !== "offer.json")
      .sort();
    writeFileSync(join(folder, ids.at(at)!, "result.md"), answer);
  };
  const said = (role: "user" | "assistant", text: string): ChatMessage => ({
    role,
    text,
    at: clock.now,
    via: "chat",
  });
  return { root, clock, jobs, log, news, finish, said };
}
const texts = (messages: ChatMessage[]) => messages.map((item) => item.text);

describe("the chat says the answer of a job when the job is done", () => {
  it("says it once, by itself, with the request and the answer", async () => {
    const made = chat();
    const news = made.news();
    // The first look only begins the journal.
    expect(news.tell()).toEqual([]);
    made.clock.now += 5_000;
    expect((await made.jobs.start("build a landing page")).ok).toBe(true);
    made.clock.now += 60_000;
    // The job still works: nothing is said.
    expect(news.tell()).toEqual([]);
    made.finish("The page is at /work/app/index.html.\nIt has a header.\n");
    made.clock.now += 2_000;
    const told = news.tell();
    expect(texts(told)).toEqual([
      "Done: build a landing page\n\nIts answer: The page is at /work/app/index.html.\nIt has a header.",
    ]);
    expect(told[0]).toMatchObject({
      role: "assistant",
      via: "chat",
      at: made.clock.now,
      // No turn made this line: the code never reads it as an answer.
      news: true,
    });
    // It is in the conversation, and it is not said again.
    expect(texts(made.log.recent())).toEqual(texts(told));
    made.clock.now += 2_000;
    expect(news.tell()).toEqual([]);
    expect(made.log.recent()).toHaveLength(1);
  });

  it("says nothing of a job that is older than its journal", async () => {
    const made = chat();
    expect((await made.jobs.start("count the files")).ok).toBe(true);
    made.clock.now += 60_000;
    made.finish("There are 12 files.\n");
    // The journal begins now: that job may have been said before.
    expect(made.news().tell()).toEqual([]);
    made.clock.now += 60_000;
    expect(made.news().tell()).toEqual([]);
    expect(made.log.recent()).toEqual([]);
  });

  it("says two jobs that are done in the order in which they started", async () => {
    const made = chat();
    const news = made.news();
    news.tell();
    made.clock.now += 5_000;
    expect((await made.jobs.start("count the files")).ok).toBe(true);
    made.clock.now += 5_000;
    expect((await made.jobs.start("list the big files")).ok).toBe(true);
    made.finish("There are 12 files.\n", 0);
    made.finish("video.mov is the biggest.\n", 1);
    made.clock.now += 5_000;
    expect(texts(news.tell())).toEqual([
      "Done: count the files\n\nIts answer: There are 12 files.",
      "Done: list the big files\n\nIts answer: video.mov is the biggest.",
    ]);
  });

  it("does not say it twice after the service starts again, and still says a job that was at work then", async () => {
    const made = chat();
    made.news().tell();
    made.clock.now += 5_000;
    expect((await made.jobs.start("count the files")).ok).toBe(true);
    made.clock.now += 5_000;
    expect((await made.jobs.start("list the big files")).ok).toBe(true);
    made.finish("There are 12 files.\n", 0);
    made.clock.now += 5_000;
    expect(texts(made.news().tell())).toHaveLength(1);
    // A new process: the journal is read from the file.
    made.clock.now += 60_000;
    expect(made.news().tell()).toEqual([]);
    made.finish("video.mov is the biggest.\n", 1);
    made.clock.now += 5_000;
    expect(texts(made.news().tell())).toEqual([
      "Done: list the big files\n\nIts answer: video.mov is the biggest.",
    ]);
  });

  it("waits while a question of ClawdTime waits for its answer", async () => {
    const made = chat();
    const news = made.news();
    news.tell();
    made.clock.now += 5_000;
    expect((await made.jobs.start("count the files")).ok).toBe(true);
    made.log.append(made.said("user", "show me that one"));
    made.log.append(made.said("assistant", "Which one: docs or payments?"));
    made.finish("There are 12 files.\n");
    made.clock.now += 10_000;
    // A line between the question and "the second one" would part them.
    expect(news.tell()).toEqual([]);
    made.log.append(made.said("user", "the second one"));
    // The person's message waits for its answer: nothing comes between.
    expect(news.tell()).toEqual([]);
    made.log.append(made.said("assistant", "Opened payments."));
    made.clock.now += 2_000;
    expect(texts(news.tell())).toEqual([
      "Done: count the files\n\nIts answer: There are 12 files.",
    ]);
    expect(texts(made.log.recent()).at(-2)).toBe("Opened payments.");
  });

  it.each([
    'This has a "don\'t" in it. Should I start this just as you said it: "build a landing page, don\'t use react"? Say yes or no.',
    "One request waits for your answer: git push. Say approve or deny to answer it.",
    'Say "tell docs: run the tests" and I type it.',
    '2 requests wait: "git push origin main" and "rm -rf node_modules". Which one do you approve? Say a word of it.',
  ])(
    "waits while ClawdTime's last message waits for a word: %j",
    async (question) => {
      const made = chat();
      const news = made.news();
      news.tell();
      made.clock.now += 5_000;
      expect((await made.jobs.start("count the files")).ok).toBe(true);
      made.log.append(made.said("assistant", question));
      made.finish("There are 12 files.\n");
      made.clock.now += 10_000;
      // "Yes" must follow the question on the screen too.
      expect(news.tell()).toEqual([]);
      made.log.append(made.said("user", "yes"));
      made.log.append(made.said("assistant", "On it."));
      made.clock.now += 2_000;
      expect(texts(news.tell())).toHaveLength(1);
    },
  );

  it("does not wait for its own line, also when that line ends with a question mark", async () => {
    const made = chat();
    const news = made.news();
    news.tell();
    made.clock.now += 5_000;
    expect((await made.jobs.start("count the files")).ok).toBe(true);
    made.finish("Which one: docs or payments?\n");
    made.clock.now += 5_000;
    expect(texts(news.tell())).toHaveLength(1);
    expect((await made.jobs.start("list the big files")).ok).toBe(true);
    made.finish("video.mov is the biggest.\n");
    made.clock.now += 5_000;
    expect(texts(news.tell())).toEqual([
      "Done: list the big files\n\nIts answer: video.mov is the biggest.",
    ]);
  });

  it("says it after a question that nobody answered for five minutes", async () => {
    const made = chat();
    const news = made.news();
    news.tell();
    made.clock.now += 5_000;
    expect((await made.jobs.start("count the files")).ok).toBe(true);
    made.log.append(made.said("assistant", "Which one: docs or payments?"));
    made.finish("There are 12 files.\n");
    made.clock.now += questionHoldMs - 1_000;
    expect(news.tell()).toEqual([]);
    made.clock.now += 2_000;
    expect(texts(news.tell())).toHaveLength(1);
  });

  it("says a long answer cut, and says so", async () => {
    const made = chat();
    const news = made.news();
    news.tell();
    made.clock.now += 5_000;
    expect((await made.jobs.start("list every file")).ok).toBe(true);
    made.finish(`${"a line of the list. ".repeat(400)}\n`);
    made.clock.now += 5_000;
    const [told] = news.tell();
    expect(told!.text.length).toBeLessThanOrEqual(2000);
    expect(told!.text).toContain("Done: list every file\n\nIts answer: a line");
    expect(
      told!.text.endsWith(" … The rest is in the terminal window of the job."),
    ).toBe(true);
  });

  it("says that a job wrote an empty answer", async () => {
    const made = chat();
    const news = made.news();
    news.tell();
    made.clock.now += 5_000;
    expect((await made.jobs.start("tidy the folder")).ok).toBe(true);
    made.finish("\n");
    made.clock.now += 5_000;
    expect(texts(news.tell())).toEqual([
      "Done: tidy the folder\n\nIts answer: The session wrote an empty answer.",
    ]);
  });

  it("does not say an answer that holds a key", async () => {
    const made = chat();
    const news = made.news();
    news.tell();
    made.clock.now += 5_000;
    expect((await made.jobs.start("print the deploy settings")).ok).toBe(true);
    made.finish(
      "The key is sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD\n",
    );
    made.clock.now += 5_000;
    const [told] = news.tell();
    expect(told!.text).not.toContain("sk-proj");
    expect(told!.text).toContain("Read it in the terminal window of the job.");
  });

  it("says nothing when the jobs cannot be read", () => {
    const made = chat();
    const news = new JobNews(made.root, {
      jobs: () => {
        throw new Error("no folder");
      },
      log: made.log,
      now: () => made.clock.now,
    });
    expect(news.tell()).toEqual([]);
  });
});

describe("the desktop service says a finished job in the chat of the panel", () => {
  const feed = (root: string, clock: { now: number }) =>
    new BoardFeed({
      root,
      model: null,
      speech: null,
      now: () => clock.now,
      runner: async () => ({ status: 0, stdout: "" }),
      system: fakeSystem({ now: start }),
      project: "/work/app",
    });

  it("adds the answer to the conversation that the panel shows", async () => {
    const made = chat();
    const board = feed(made.root, made.clock);
    expect(board.tellJobs()).toEqual([]);
    made.clock.now += 5_000;
    expect((await made.jobs.start("build a landing page")).ok).toBe(true);
    made.finish("The page is at /work/app/index.html.\n");
    made.clock.now += 2_000;
    expect(texts(board.tellJobs())).toEqual([
      "Done: build a landing page\n\nIts answer: The page is at /work/app/index.html.",
    ]);
    expect(texts(board.chat().messages)).toEqual([
      "Done: build a landing page\n\nIts answer: The page is at /work/app/index.html.",
    ]);
    expect(board.tellJobs()).toEqual([]);
    board.close();
  });

  it("says nothing where the service has no jobs", () => {
    const made = chat();
    const board = new BoardFeed({
      root: made.root,
      model: null,
      speech: null,
      now: () => made.clock.now,
      system: fakeSystem({ now: start }),
    });
    expect(board.tellJobs()).toEqual([]);
    board.close();
  });
});
