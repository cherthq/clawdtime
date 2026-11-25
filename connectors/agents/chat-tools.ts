/**
 * The tools of the chat agent, and the gate in front of them.
 *
 * Each tool is a thin adapter over code that exists already: the computer
 * engine's submit, answer, stop and snapshot; the jobs; the desk of
 * decisions; the memory and the trove; the routines; and the task graph. No
 * tool does the work a second way.
 *
 * The gate holds the safety rules in code, before every call:
 *
 * - After a call ended, nothing more starts on it.
 * - In a turn where the owner said stop, nothing new starts: the stop came
 *   first, in code, before the model read the message.
 * - No argument that holds a credential goes to a tool.
 * - An approval of the computer engine is answered only by the owner's own
 *   newest words, and only when they are a clear yes or no by the strict
 *   check that the chat already uses. A request of an agent on the desk is
 *   decided only by the owner's own words, read by the call's strict reader.
 * - Memory tools exist only while memory is on.
 *
 * The computer engine keeps its own ask policy and checks for every action.
 */
import { firstWordsMs, type SupervisorWorld } from "./brain.js";
import type { LoopTool, CallSeen, GateVerdict } from "./agent-loop.js";
import { explicitApprovalNo, explicitApprovalYes, interpret } from "./call.js";
import type { DecisionDesk, DecisionRequest } from "./decisions.js";
import { jobAgents, type JobAgent, type JobPort } from "./jobs.js";
import { factKinds, looksSecret, terms, type FactKind } from "./memory.js";
import { phoneIsLive } from "./phone-turn.js";
import { title } from "./render.js";
import { pickSession } from "./topics.js";
import type { AgentSession } from "./types.js";
import { clean } from "../computer/guards.js";
import { looksSecretStrict } from "../computer/journal.js";
import { readMidTask } from "../computer/orders.js";
import type { Routine } from "../computer/routines.js";
import type { ProcessDesk } from "../system/act.js";
import { systemTools } from "./system-tools.js";
import {
  graphText,
  isActive,
  type TaskGraph,
  type TaskNode,
} from "./task-graph.js";

/** What the routine tools need: the public surface of `Routines`. */
export interface RoutinePort {
  list(): Routine[];
  add(words: string): { ok: boolean; message: string; routine?: Routine };
  pause(id: string): Routine | null;
  resume(id: string): Routine | null;
  remove(id: string): Routine | null;
  line(routine: Routine): string;
}

/** What the tools reach. */
export interface ChatToolWorld {
  now(): number;
  execution?: SupervisorWorld["execution"] | undefined;
  jobs?: JobPort | undefined;
  desk: DecisionDesk;
  routines?: RoutinePort | undefined;
  board?: SupervisorWorld["board"] | undefined;
  titles?: SupervisorWorld["titles"] | undefined;
  callView?: SupervisorWorld["callView"] | undefined;
  graph: TaskGraph;
  /** Feeds the graph from the real sources. */
  refresh(): void;
  /** The process level of the Mac, for debugging (`system-tools.ts`). Absent: no such tools. */
  system?: ProcessDesk | undefined;
}

/** What one turn knows while it runs. */
export interface ChatTurn {
  /** The id that every effect of the turn carries, with its own number. */
  id: string;
  /** The owner's newest words in this turn. Messages taken in mid-run replace it. */
  owner: string;
  /** When those words came. A question asked after them is not theirs to answer. */
  ownerAt: number;
  /** Those words answered a question already: one message answers one question. */
  answered: boolean;
  /** The words of ClawdTime's own offer of a next step, when the owner's newest words said yes to it. */
  offered: string;
  /** What the owner said lately, oldest first, for a job. */
  said: string[];
  via: "chat" | "voice" | "call";
  /** The owner said stop in this turn. */
  stopTurn: boolean;
  /** The request node of this turn, made at its first effect. */
  request(): TaskNode;
  /** A number for each effect of the turn. */
  next(): number;
}

const live = new Set([
  "running",
  "waiting_for_person",
  "stopping",
  "queued",
  "dispatching",
  "paused",
]);

/** The work, or "" at the owner's Stop: a stopped turn waits for nothing more. */
const untilStopped = (work: Promise<string>, signal: AbortSignal) =>
  signal.aborted
    ? Promise.resolve("")
    : new Promise<string>((resolve) => {
        const stop = () => resolve("");
        signal.addEventListener("abort", stop, { once: true });
        void work.then((value) => {
          signal.removeEventListener("abort", stop);
          resolve(value);
        });
      });

/** The computer task that runs now, or null. */
export function runningTask(world: ChatToolWorld) {
  const snapshot = world.execution?.snapshot();
  if (!snapshot?.configured || !live.has(snapshot.state)) return null;
  return snapshot;
}

const text = (description: string) => ({ type: "string", description });
const schema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const word = (args: Record<string, unknown>, key: string, limit = 2000) =>
  typeof args[key] === "string" ? clean(args[key] as string, limit) : "";

/** The node of the computer task that the engine names, after a refresh. */
const computerNode = (world: ChatToolWorld, requestId: string | undefined) =>
  requestId ? world.graph.bySource(`computer:${requestId}`) : null;

const tagged = (message: string, node: TaskNode | null) =>
  node ? `${message} (task ${node.id}, ${node.state})` : message;

/** The words of every string argument, for the credential check. */
const strings = (args: Record<string, unknown>) =>
  Object.values(args).filter(
    (value): value is string => typeof value === "string",
  );

/** Tools that change something. The rest only read. */
export const effectTools = new Set([
  "computer_do",
  "computer_steer",
  "computer_stop",
  "answer_question",
  "start_job",
  "remember",
  "routine_add",
  "routine_pause",
  "routine_remove",
  "call_view",
  "process_act",
]);

/**
 * The question that answer_question would answer. Only what waits now can be
 * answered: the one question of the computer engine that its snapshot asks,
 * or a request on the desk. An id that the model gives must name one of
 * them. While more than one waits, one message cannot say which it answers,
 * so none is answered here.
 */
export function questionTarget(
  world: ChatToolWorld,
  id: string,
):
  | {
      kind: "computer";
      waiting: "approval" | "question" | "takeover";
      node: TaskNode | null;
    }
  | { kind: "desk"; request: DecisionRequest; node: TaskNode | null }
  | { kind: "none"; reason: string } {
  world.refresh();
  const snapshot = world.execution?.snapshot();
  const computerWaits =
    snapshot?.configured &&
    snapshot.state === "waiting_for_person" &&
    snapshot.waiting
      ? snapshot.waiting
      : null;
  const asking = computerWaits
    ? (world.graph
        .nodes()
        .find(
          (node) =>
            node.kind === "question" &&
            isActive(node.state) &&
            node.source?.startsWith(`question:${snapshot!.requestId}:`),
        ) ?? null)
    : null;
  const pending = world.desk.pending();
  const waiting: string[] = [
    ...(computerWaits
      ? [`the computer task asks "${clean(snapshot!.message, 80)}"`]
      : []),
    ...pending.map(
      (request) =>
        `${request.agent} asks to run "${clean(request.summary, 60)}"`,
    ),
  ];
  if (waiting.length > 1)
    return {
      kind: "none",
      reason: `Two questions wait for the owner: ${waiting.join("; and ")}. One message cannot say which it answers, so none is answered here. Tell the owner both: they answer an agent's request in the list of requests or in its terminal, and then a yes or no here answers the computer task.`,
    };
  if (id) {
    const node = world.graph.get(id);
    const named =
      node?.kind === "question" && isActive(node.state) ? node : null;
    const desk = named?.source?.startsWith("desk:")
      ? pending.find((request) => `desk:${request.id}` === named.source)
      : undefined;
    if (desk) return { kind: "desk", request: desk, node: named };
    if (named && asking && named.id === asking.id && computerWaits)
      return { kind: "computer", waiting: computerWaits, node: asking };
    return {
      kind: "none",
      reason: `${clean(id, 20)} is no question that waits now. Read the task list again.`,
    };
  }
  if (computerWaits)
    return { kind: "computer", waiting: computerWaits, node: asking };
  if (pending.length === 1)
    return {
      kind: "desk",
      request: pending[0]!,
      node: world.graph.bySource(`desk:${pending[0]!.id}`),
    };
  return { kind: "none", reason: "No question waits for the owner now." };
}

/**
 * What the owner's own words decide for a request on the desk, or null. A
 * permission or a plan is decided only by a message that is a plain yes or
 * no, nothing more: "ok, now search for shoes" decides nothing. A question
 * takes one of its choices by the strict reader of a call, never an allow.
 */
export function deskDecision(
  owner: string,
  request: DecisionRequest,
): { decision: "allow" | "deny" | "answer"; text: string | null } | null {
  const words = clean(owner, 600);
  if (request.kind === "question") {
    const read = interpret(words, request);
    return read && read.decision !== "allow" ? read : null;
  }
  if (explicitApprovalYes.test(words)) return { decision: "allow", text: null };
  if (explicitApprovalNo.test(words)) return { decision: "deny", text: words };
  return null;
}

/**
 * Words of steps that the computer engine takes as already allowed when its
 * goal says them: it then asks no yes before it sends, posts, pays or
 * deletes. So a goal may hold them only where the owner said them.
 */
const riskyWords = [
  "send",
  "post",
  "publish",
  "tweet",
  "retweet",
  "repost",
  "reply",
  "respond",
  "comment",
  "share",
  "forward",
  "submit",
  "buy",
  "purchase",
  "order",
  "pay",
  "checkout",
  "book",
  "reserve",
  "subscribe",
  "unsubscribe",
  "donate",
  "transfer",
  "delete",
  "remove",
  "erase",
  "trash",
  "discard",
  "cancel",
  "archive",
  "like",
  "follow",
  "unfollow",
  "accept",
  "decline",
  "approve",
  "confirm",
  "install",
  "uninstall",
  "overwrite",
  "empty",
].flatMap((item) => terms(item));
const riskyTerms = new Set(riskyWords);

/** The first word of a risky step in the goal that the owner did not say, or null. */
export function unsaidStep(
  goal: string,
  said: readonly string[],
): string | null {
  const own = new Set(terms(said.join(" ")));
  return (
    terms(goal).find((item) => riskyTerms.has(item) && !own.has(item)) ?? null
  );
}

/**
 * The gate: the safety rules in code, before every call. A refusal is a
 * reason that the model reads as the result.
 */
export function chatGate(
  world: ChatToolWorld,
  turn: ChatTurn,
  options: { memoryOn: () => boolean },
): (call: CallSeen) => GateVerdict {
  return (call) => {
    const effect = effectTools.has(call.name);
    if (effect && !phoneIsLive())
      return {
        allow: false,
        reason: "The call ended. Nothing more starts from it.",
      };
    if (effect && turn.stopTurn)
      return {
        allow: false,
        reason:
          "The owner said stop in this message, and code already stopped what ran. Nothing new starts in this turn: say briefly what stopped, and that they can ask again.",
      };
    if (
      strings(call.args).some(
        (value) => looksSecret(value) || looksSecretStrict(value),
      )
    )
      return {
        allow: false,
        reason:
          "That holds a password, a key or a code. It is never passed on: the owner types it on the Mac themselves.",
      };
    if (
      (call.name === "remember" || call.name === "memory_search") &&
      !options.memoryOn()
    )
      return {
        allow: false,
        reason:
          "Memory is off. The owner turns it on with: clawdtime memory on.",
      };
    if (call.name === "computer_do" || call.name === "routine_add") {
      const goal = word(
        call.args,
        call.name === "computer_do" ? "goal" : "schedule",
      );
      const step = unsaidStep(goal, [...turn.said, turn.offered]);
      if (step)
        return {
          allow: false,
          reason: `The goal says "${step}", which the owner did not say. The computer task takes a goal's words as the owner's own yes for such a step, so a goal holds only what they said: use their words, and the task asks them before it does more.`,
        };
    }
    if (call.name === "computer_steer") {
      const task = runningTask(world);
      const words = word(call.args, "words");
      if (task?.waiting === "question" || task?.waiting === "takeover")
        return {
          allow: false,
          reason:
            "The task waits for the owner's answer to its question. Give that with answer_question.",
        };
      // The worker reads words for a running task with its own reader: a
      // stop stops it and a question about progress only gets an answer.
      // Neither is a change of the task.
      const kind = task && words ? readMidTask(words) : "steer";
      if (kind === "stop")
        return {
          allow: false,
          reason: "Those words stop the task: use computer_stop.",
        };
      if (kind === "status")
        return {
          allow: false,
          reason:
            "Those words ask how the task goes; they change nothing. Read computer_status instead.",
        };
    }
    if (call.name === "answer_question") {
      if (turn.answered)
        return {
          allow: false,
          reason:
            "The owner's newest message answered a question already. One message answers one question: ask them about this one.",
        };
      const target = questionTarget(world, word(call.args, "id", 20));
      if (target.kind === "none")
        return { allow: false, reason: target.reason };
      const asked =
        target.kind === "desk"
          ? target.request.createdAt
          : target.node?.createdAt;
      // The owner answers what they could see: a question that came after
      // their words is not answered by them.
      if (asked === undefined || asked > turn.ownerAt)
        return {
          allow: false,
          reason:
            "That question came after the owner's newest message, so those words do not answer it. Tell them what it asks.",
        };
      const owner = clean(turn.owner, 600);
      if (target.kind === "computer" && target.waiting === "approval") {
        if (!explicitApprovalYes.test(owner) && !explicitApprovalNo.test(owner))
          return {
            allow: false,
            reason:
              "An approval is answered only by the owner's own clear yes or no, and their newest message is neither. Ask them, in a few words, yes or no.",
          };
      }
      if (target.kind === "desk") {
        const decision = deskDecision(owner, target.request);
        if (!decision)
          return {
            allow: false,
            reason:
              "A request of an agent is decided only by a message of the owner that is a plain yes or no, or one of its choices, and their newest message is not. Ask them: allow or deny.",
          };
        if (decision.decision === "allow" && target.request.answerInTerminal)
          return {
            allow: false,
            reason:
              "That request is not shown whole here: it can be allowed only in its own terminal. A denial is taken here.",
          };
      }
    }
    return { allow: true };
  };
}

/** Shortens a result and keeps every credential out of what the model reads. */
export function afterCall(_call: CallSeen, result: string): string {
  if (looksSecret(result) || looksSecretStrict(result))
    return "[The result held a password, a key or a code, so it is withheld.]";
  return result.length > 1_500 ? `${result.slice(0, 1_494)} [cut]` : result;
}

/** The tools that exist for this turn. What does not exist here is not offered. */
export function chatTools(
  world: ChatToolWorld,
  turn: ChatTurn,
  options: { memoryOn: () => boolean },
): LoopTool[] {
  const tools: LoopTool[] = [];
  const execution = world.execution;
  if (execution) {
    tools.push(
      {
        name: "computer_do",
        description:
          "Start a task on this Mac now: work in an app, on a web page or in an account (search, shop, X, Instagram, mail, calendar, messages, files, settings). Call it at once when the owner asks for such work; do not ask first. goal: the owner's request in their own words, made whole from the conversation ('it' replaced by what it means). Add nothing they did not ask for.",
        parameters: schema(
          { goal: text("The owner's request, whole, in their words.") },
          ["goal"],
        ),
        effect: true,
        async run(args, signal) {
          const goal = word(args, "goal");
          if (!goal) return "Not started: the goal is empty.";
          world.refresh();
          const before = execution.snapshot();
          if (!before.configured) return `Not started. ${before.message}`;
          const runningNow = runningTask(world);
          if (runningNow) {
            const node = computerNode(world, runningNow.requestId);
            return `Not started: a computer task still runs${node ? ` (${node.id}: "${node.title}")` : ""}. Add these words to it with computer_steer, stop it with computer_stop, or wait for it.`;
          }
          const request = turn.request();
          const eventId = `${turn.id}_do${turn.next()}`;
          let { message } = await execution.submit(eventId, goal);
          // The app-owned worker starts with no words: its first words (what
          // it does first, a question or the end) come a moment later.
          if (!message && execution.firstWords)
            message = await untilStopped(
              execution.firstWords(eventId, firstWordsMs).catch(() => ""),
              signal,
            );
          world.refresh();
          const after = execution.snapshot();
          const node =
            after.requestId && after.requestId !== before.requestId
              ? computerNode(world, after.requestId)
              : null;
          if (node) world.graph.link(node.id, "spawnedBy", request.id);
          else
            world.graph.settle(
              request.id,
              "failed",
              "the computer task did not start",
            );
          return tagged(
            message || "The computer task started.",
            node ? world.graph.get(node.id) : null,
          );
        },
      },
      {
        name: "computer_steer",
        description:
          "Add the owner's words to the computer task that runs now: a correction, a detail or a change of plan ('no, the Pro Max', 'use Safari instead', 'also check the reviews'). The task goes on with them. words: what they said for it.",
        parameters: schema(
          { words: text("The owner's words for the running task.") },
          ["words"],
        ),
        effect: true,
        async run(args) {
          const words = word(args, "words");
          if (!words) return "Nothing was added: the words are empty.";
          world.refresh();
          const task = runningTask(world);
          if (!task)
            return "No computer task runs now. Start one with computer_do.";
          if (task.waiting === "approval")
            return "The task waits for the owner's yes or no on its question. Answer that with answer_question.";
          const node = computerNode(world, task.requestId);
          const request = turn.request();
          const { message } = await execution.submit(
            `${turn.id}_steer${turn.next()}`,
            words,
          );
          world.refresh();
          if (node) {
            world.graph.link(request.id, "followsUp", node.id);
            world.graph.settle(request.id, "done", "added to the running task");
          }
          return tagged(message, node ? world.graph.get(node.id) : null);
        },
      },
      {
        name: "computer_stop",
        description: "Stop the computer task that runs now.",
        parameters: schema({}),
        effect: true,
        async run() {
          world.refresh();
          const task = runningTask(world);
          const stopped = execution.stop();
          world.refresh();
          return tagged(
            stopped.message,
            computerNode(world, task?.requestId ?? stopped.requestId),
          );
        },
      },
      {
        name: "computer_status",
        description:
          "Read what the computer task does now: its state, its step or question, what the owner added, and its newest report.",
        parameters: schema({}),
        effect: false,
        async run() {
          world.refresh();
          const snapshot = execution.snapshot();
          const node = computerNode(world, snapshot.requestId);
          return [
            `State: ${snapshot.state}${snapshot.waiting ? ` (waits for the owner: ${snapshot.waiting})` : ""}.`,
            snapshot.goal ? `Goal: ${snapshot.goal}` : "",
            snapshot.guidance?.length
              ? `The owner added: ${snapshot.guidance.join(" | ")}`
              : "",
            `Report: ${snapshot.message}`,
            node ? `Task ${node.id}, ${node.state}.` : "",
          ]
            .filter(Boolean)
            .join("\n");
        },
      },
    );
  }
  tools.push({
    name: "answer_question",
    description:
      "Give the owner's answer to a question that waits for them: the computer task's question (a yes or no, a choice, or 'go on' after they took over the Mac), or an agent's request on the desk (by its q id). For a yes or no, pass the owner's own words; code checks them.",
    parameters: schema(
      {
        id: text("The q id of the question, when more than one waits."),
        answer: text("The owner's answer."),
      },
      ["answer"],
    ),
    effect: true,
    async run(args) {
      const answer = word(args, "answer", 600);
      const target = questionTarget(world, word(args, "id", 20));
      if (target.kind === "none") return target.reason;
      const owner = clean(turn.owner, 600);
      const request = turn.request();
      if (target.node) world.graph.link(request.id, "answers", target.node.id);
      if (target.kind === "computer") {
        if (!execution?.answer)
          return "This computer engine takes no answers here.";
        // A yes or no, and a go-on after a takeover, are the owner's own words.
        const words = target.waiting === "question" ? answer || owner : owner;
        turn.answered = true;
        const { message } = await execution.answer(words);
        world.refresh();
        world.graph.settle(request.id, "done", "answered");
        return message;
      }
      const pending = target.request;
      const decision = deskDecision(owner, pending);
      if (!pending || !decision) return "That request no longer waits.";
      turn.answered = true;
      const taken = world.desk.answer(pending.id, {
        decision: decision.decision,
        text: decision.text,
        via: turn.via === "call" ? "call" : "panel",
      });
      world.refresh();
      world.graph.settle(
        request.id,
        taken ? "done" : "failed",
        taken ? "answered" : "not taken",
      );
      return taken
        ? `${decision.decision === "allow" ? "Allowed" : decision.decision === "deny" ? "Denied" : `Answered "${decision.text ?? ""}"`}: ${clean(pending.summary, 120)}`
        : "The desk did not take that answer: the request no longer waits.";
    },
  });
  if (world.jobs) {
    const jobs = world.jobs;
    tools.push(
      {
        name: "start_job",
        description:
          "Hand code work to a coding agent in a new terminal session on this Mac: a repository, a bug, a test, a build, a script, a pull request, a server, a terminal command. Never for work in apps or web pages. work: the owner's request in their words, made whole. agent: only when the owner names one.",
        parameters: schema(
          {
            work: text("The code work, whole, in the owner's words."),
            agent: { type: "string", enum: [...jobAgents] },
          },
          ["work"],
        ),
        effect: true,
        async run(args) {
          const work = word(args, "work");
          const agent = jobAgents.includes(args.agent as JobAgent)
            ? (args.agent as JobAgent)
            : undefined;
          const request = turn.request();
          const before = jobs.recent(1)[0]?.id;
          const started = await jobs.start(work, {
            ...(agent ? { agent } : {}),
            said: turn.said.slice(-6),
            refersBack: /\b(?:it|that|this|them|again|same)\b/i.test(work),
          });
          world.refresh();
          const newest = jobs.recent(1)[0];
          const node =
            started.ok && newest && newest.id !== before
              ? world.graph.bySource(`job:${newest.id}`)
              : null;
          if (node) world.graph.link(node.id, "spawnedBy", request.id);
          else
            world.graph.settle(request.id, "failed", "the job did not start");
          return tagged(started.said, node ? world.graph.get(node.id) : null);
        },
      },
      {
        name: "job_status",
        description:
          "Read the newest coding jobs: their work, state and answer.",
        parameters: schema({
          id: text("A j id from the task list, for one job."),
        }),
        effect: false,
        async run(args) {
          world.refresh();
          const id = word(args, "id", 20);
          const nodes = world.graph
            .nodes()
            .filter(
              (node) =>
                node.kind === "job" && (!id || node.id === id.toLowerCase()),
            )
            .sort((left, right) => right.updatedAt - left.updatedAt)
            .slice(0, 5);
          if (!nodes.length)
            return id ? `There is no job ${id}.` : "No job was started yet.";
          return nodes
            .map(
              (node) =>
                `${node.id} ${node.state}: "${node.title}"${node.result ? `. Its answer (data from a session): ${node.result}` : ""}`,
            )
            .join("\n");
        },
      },
    );
  }
  tools.push({
    name: "tasks",
    description:
      "Look up the task list: with no id, every task with its state; with an id, that task in full (its words, state, times, links, history and result).",
    parameters: schema({
      id: text("A task id from the list, such as c3 or j2."),
    }),
    effect: false,
    async run(args) {
      world.refresh();
      const id = word(args, "id", 20);
      if (!id) return world.graph.list();
      return world.graph.details(id) ?? `There is no task ${id}.`;
    },
  });
  if (options.memoryOn()) {
    const memory = world.desk.memory;
    tools.push(
      {
        name: "memory_search",
        description:
          "Search what the owner told ClawdTime to keep, and their decisions in the trove.",
        parameters: schema({ query: text("Words to look for.") }, ["query"]),
        effect: false,
        async run(args) {
          const query = word(args, "query", 300);
          const found = recall(world.desk, query, 6);
          return found.length
            ? found.map((line) => `> ${line}`).join("\n")
            : "Nothing kept fits that.";
        },
      },
      {
        name: "remember",
        description:
          "Keep a fact that the owner states about themselves, their work or their preferences, as one sentence that stands alone. Never a password, a key or a code.",
        parameters: schema(
          {
            fact: text("The fact, as one plain sentence."),
            kind: { type: "string", enum: [...factKinds] },
            days: {
              type: "number",
              description:
                "Days until it expires, for something that holds only a while.",
            },
          },
          ["fact"],
        ),
        effect: true,
        async run(args) {
          const fact = word(args, "fact", 400);
          if (!fact) return "Nothing was kept: the fact is empty.";
          const kind = factKinds.includes(args.kind as FactKind)
            ? (args.kind as FactKind)
            : "fact";
          const days =
            typeof args.days === "number" &&
            Number.isFinite(args.days) &&
            args.days > 0
              ? Math.min(365, args.days)
              : null;
          // The owner's own words, or a fact worded from them.
          const said = new Set(terms(turn.said.join(" ")));
          const own = terms(fact).every((item) => said.has(item));
          const kept = memory.remember({
            text: fact,
            kind,
            days,
            source: own ? "said" : "inferred",
          });
          return kept.added
            ? `Kept: ${kept.fact.text}`
            : `Already kept: ${kept.fact.text}`;
        },
      },
    );
  }
  if (world.routines) {
    const routines = world.routines;
    tools.push(
      {
        name: "routine_add",
        description:
          "Keep a routine: a request that runs on the Mac at a time of day, with the result texted to the owner. schedule: the owner's sentence in the form 'every morning at 9, check my X mentions'.",
        parameters: schema(
          { schedule: text("When and what, as one sentence.") },
          ["schedule"],
        ),
        effect: true,
        async run(args) {
          const request = turn.request();
          const added = routines.add(word(args, "schedule", 400));
          world.refresh();
          const node = added.routine
            ? world.graph.bySource(`routine:${added.routine.id}`)
            : null;
          if (node && !node.links.spawnedBy)
            world.graph.link(node.id, "spawnedBy", request.id);
          else if (!added.ok)
            world.graph.settle(request.id, "failed", "no routine kept");
          return added.message;
        },
      },
      {
        name: "routine_list",
        description: "List the routines with their schedules.",
        parameters: schema({}),
        effect: false,
        async run() {
          const list = routines.list();
          return list.length
            ? list.map((routine) => routines.line(routine)).join("\n")
            : "There is no routine yet.";
        },
      },
      {
        name: "routine_pause",
        description:
          "Pause a routine by its id, or with resume true start it again.",
        parameters: schema(
          {
            id: text("The routine's eight-letter id."),
            resume: { type: "boolean" },
          },
          ["id"],
        ),
        effect: true,
        async run(args) {
          const id = word(args, "id", 20);
          const routine =
            args.resume === true ? routines.resume(id) : routines.pause(id);
          world.refresh();
          if (!routine) return `There is no routine ${id}.`;
          return args.resume === true
            ? `Routine ${routine.id} runs again.`
            : `Paused routine ${routine.id}. A request that it started goes on.`;
        },
      },
      {
        name: "routine_remove",
        description: "Remove a routine by its id.",
        parameters: schema({ id: text("The routine's eight-letter id.") }, [
          "id",
        ]),
        effect: true,
        async run(args) {
          const id = word(args, "id", 20);
          const routine = routines.remove(id);
          world.refresh();
          return routine
            ? `Removed routine ${routine.id}. A request that it started goes on.`
            : `There is no routine ${id}.`;
        },
      },
    );
  }
  if (world.callView) {
    const callView = world.callView;
    tools.push({
      name: "call_view",
      description:
        "Choose what the video of a call shows: zoom in on one open application window (target 'app' with app name), zoom in on one coding session's terminal window (target 'session' with session name or topic), or show the whole screen again (target 'screen').",
      parameters: schema(
        {
          target: { type: "string", enum: ["app", "session", "screen"] },
          app: text(
            "For target app: the open application's name, such as Stonepad or Safari.",
          ),
          session: text(
            "For target session: the coding session's name, or a few words about its job.",
          ),
        },
        ["target"],
      ),
      effect: true,
      async run(args) {
        const target = word(args, "target", 20);
        if (target === "screen") {
          try {
            return (await callView(null)).said;
          } catch {
            return "The view of the call did not change.";
          }
        }
        if (target === "app") {
          const app = word(args, "app", 80);
          if (!app)
            return "Tell me which open app window you want to zoom in on.";
          try {
            return (await callView({ app })).said;
          } catch {
            return "The view of the call did not change.";
          }
        }
        if (target === "session") {
          const query = word(args, "session", 200);
          const sessions = world.board?.()?.sessions ?? [];
          if (!sessions.length)
            return "There are no active coding sessions on the board to show.";
          const titles = (session: AgentSession) => {
            try {
              return world.titles?.(session) ?? [title(session)];
            } catch {
              return [title(session)];
            }
          };
          const byOwner = pickSession(turn.owner, sessions, titles);
          const byQuery = query
            ? pickSession(query, sessions, titles)
            : ({ kind: "none" } as const);
          let pick = byOwner;
          if (byOwner.kind === "one") {
            if (
              byQuery.kind === "one" &&
              byQuery.session !== byOwner.session &&
              byQuery.session.focus !== "none"
            ) {
              pick = {
                kind: "many",
                sessions: [byOwner.session, byQuery.session],
              };
            }
          } else if (byQuery.kind === "one") {
            if (
              byOwner.kind === "none" ||
              byOwner.sessions.includes(byQuery.session)
            ) {
              pick = byQuery;
            }
          } else if (byOwner.kind === "none" && byQuery.kind === "many") {
            pick = byQuery;
          }
          if (pick.kind === "none")
            return "I could not find a coding session that matches that.";
          if (pick.kind === "many")
            return `More than one coding session matches: ${pick.sessions.map((item) => title(item)).join(", ")}. Tell me which one to show.`;
          try {
            return (await callView(pick.session)).said;
          } catch {
            return "The view of the call did not change.";
          }
        }
        return "Invalid call view target. Use app, session, or screen.";
      },
    });
  }
  if (world.system)
    tools.push(
      ...systemTools(world.system, turn, {
        computerBusy: () => runningTask(world) !== null,
      }),
    );
  return tools;
}

/**
 * The notes of the memory and the trove that fit some words: the memory's
 * own search, then the trove's notes that share the most words with them.
 * Nothing here is a credential: memory never keeps one, and a note that
 * looks like one is left out.
 */
export function recall(desk: DecisionDesk, words: string, limit = 4): string[] {
  const out: string[] = [];
  try {
    for (const { fact } of desk.memory.search(words, { limit, threshold: 0.2 }))
      out.push(
        `${graphText(fact.text, 300)}${fact.source === "inferred" ? " (inferred)" : ""}`,
      );
  } catch {
    // A memory that cannot be read gives no notes.
  }
  try {
    const asked = new Set(terms(words));
    if (asked.size)
      for (const note of desk.trove
        .notes(200)
        .map((note) => ({
          note,
          shared: terms(note.text).filter((item) => asked.has(item)).length,
        }))
        .filter((item) => item.shared >= Math.min(2, asked.size))
        .sort(
          (left, right) =>
            right.shared - left.shared || right.note.at - left.note.at,
        )
        .slice(0, Math.max(1, limit - out.length)))
        out.push(`Decision: ${graphText(note.note.text, 300)}`);
  } catch {
    // A trove that cannot be read gives no notes.
  }
  return out
    .filter((line) => !looksSecret(line) && !looksSecretStrict(line))
    .slice(0, limit);
}
