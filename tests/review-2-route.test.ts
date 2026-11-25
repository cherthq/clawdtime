import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Supervisor,
  type ModelClient,
  type SupervisorWorld,
} from "../connectors/agents/brain.js";
import { DecisionDesk } from "../connectors/agents/decisions.js";
import type { JobPort } from "../connectors/agents/jobs.js";
import { ComputerJournal } from "../connectors/computer/journal.js";
import { ComputerWorker } from "../connectors/computer/worker.js";
import type { DesktopExecutionSnapshot } from "../src/control/desktop-executor.js";
import {
  element,
  FakeHands,
  observation,
  ScriptedPlanner,
  until,
} from "./connectors-computer-fixture.js";

// Review 2: a message that holds the work back, or puts it off, starts the
// computer engine at once. Red on 461f812.

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);
const folder = () => {
  const path = mkdtempSync(join(tmpdir(), "clawdtime-review-2-route-"));
  roots.push(path);
  return path;
};

/** A model that only says "Okay.": the code alone decides the road. */
const quiet: ModelClient = {
  async complete() {
    return { text: "Okay.", toolCalls: [] };
  },
};

/** A Mac with an idle computer engine that records what it got. */
function mac() {
  const events: string[] = [];
  const state: DesktopExecutionSnapshot = {
    configured: true,
    mode: "native",
    state: "idle",
    canStop: false,
    message: "Nothing runs.",
  };
  const jobs: JobPort = {
    async start(job) {
      events.push(`job: ${job}`);
      return { ok: true, said: "Started a job." };
    },
    recent: () => [],
  };
  const started = "Started.";
  const world: SupervisorWorld = {
    now: () => Date.now(),
    board: () => null,
    desk: new DecisionDesk(folder()),
    focus: async () => ({ ok: false }),
    send: async () => ({ ok: false, route: "none" }),
    clis: () => [],
    jobs,
    execution: {
      snapshot: () => state,
      submit: async (_id: string, text: string) => {
        events.push(`engine: ${text}`);
        return { message: started };
      },
      submitRead: async (_id: string, text: string) => {
        events.push(`engine: ${text}`);
        return { message: started };
      },
      stop: () => state,
      answer: async () => ({ message: "No question waits." }),
    },
  };
  return { world, events };
}

describe("review 2: a hold cue or a later time is routed as work for now", () => {
  it.each([
    "hang on, reply to Sam",
    "hold on and reply to Sam",
    "pause, then reply to Sam",
    "reply to Sam but wait for me",
    "Reply to Sam tomorrow",
    "reply to Sam after the meeting",
    "Book the 3pm slot once I confirm",
  ])("starts nothing on the screen for %j", async (words) => {
    const f = mac();
    await new Supervisor(f.world, quiet).reply([], words, "chat");
    expect(f.events).toEqual([]);
  });
});

describe("review 2: the same words, as the goal of the worker, lift the send guard at once", () => {
  it.each([
    "hang on, reply to Sam",
    "Reply to Sam tomorrow",
    "reply to Sam but wait for me",
  ])("sends nothing as the owner with no yes for %j", async (words) => {
    const hands = new FakeHands([observation([element(1, { title: "Send" })])]);
    const planner = new ScriptedPlanner([
      { kind: "click_element", element: 1 },
      { kind: "done", summary: "Replied." },
    ]);
    const worker = new ComputerWorker({
      hands,
      planner,
      journal: new ComputerJournal(folder()),
      notify: () => {},
    });
    await worker.submit("r1", words);
    await until(() => worker.snapshot().state !== "running");
    expect(hands.sent).toEqual([]);
    worker.stop();
  });
});
