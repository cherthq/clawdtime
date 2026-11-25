/**
 * The task graph: the live record of the work that the chat started or sees.
 *
 * A node is one piece of work: a request of the owner, a computer task, a
 * coding job, a routine, a question that waits for the owner, or a call or
 * text of the reach. Each node has an id, a kind, a title in the owner's
 * words, a state (queued, running, waiting, done, failed, canceled), its
 * times, a short history of its states, and links to other nodes: spawned
 * by, waits on, answers, follows up.
 *
 * Rules that are code here:
 *
 * - The graph is fed only from the real sources: the computer engine's
 *   snapshot and journal, the jobs, the routines, the reach and the desk of
 *   decisions. The chat adds only the owner's requests and the links from
 *   them. A state in the graph is never a claim of the model.
 * - It lives in one owner-only file in the state folder. A file that cannot
 *   be read gives an empty graph; nothing in it is ever trusted as an order.
 * - No title, detail or result holds a credential: such text is withheld.
 * - The view for the model is compact: the active nodes first, then the last
 *   few that ended, within a fixed number of characters.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { DesktopExecutionSnapshot } from "../../src/control/desktop-executor.js";
import { secureWrite } from "../shared/state.js";
import { clean } from "../computer/guards.js";
import { looksSecretStrict, type JournalRequest } from "../computer/journal.js";
import type { ReachRecord } from "../computer/reach.js";
import { scheduleText, type Routine } from "../computer/routines.js";
import type { DecisionRequest } from "./decisions.js";
import type { JobFacts } from "./jobs.js";

export const nodeKinds = [
  "request",
  "computer",
  "job",
  "routine",
  "question",
  "reach",
] as const;
export type NodeKind = (typeof nodeKinds)[number];
export const nodeStates = [
  "queued",
  "running",
  "waiting",
  "done",
  "failed",
  "canceled",
] as const;
export type NodeState = (typeof nodeStates)[number];
const activeStates = new Set<NodeState>(["queued", "running", "waiting"]);
export const isActive = (state: NodeState) => activeStates.has(state);

/** The first letter of each id says its kind. */
const prefix: Record<NodeKind, string> = {
  request: "r",
  computer: "c",
  job: "j",
  routine: "s",
  question: "q",
  reach: "m",
};
const nodeId = z.string().regex(/^[rcjsqm][0-9]{1,7}$/);
const moment = z.number().int().nonnegative();
const nodeSchema = z
  .object({
    id: nodeId,
    kind: z.enum(nodeKinds),
    title: z.string().max(160),
    state: z.enum(nodeStates),
    createdAt: moment,
    updatedAt: moment,
    endedAt: moment.optional(),
    /** The real record behind the node: "computer:ID", "job:ID", "routine:ID". */
    source: z.string().max(200).optional(),
    /** One line of what is going on: the step, the schedule, why it waits. */
    detail: z.string().max(200).optional(),
    /** What it came to, in the words of its source. */
    result: z.string().max(400).optional(),
    links: z
      .object({
        spawnedBy: nodeId.optional(),
        waitsOn: z.array(nodeId).max(8).optional(),
        answers: nodeId.optional(),
        followsUp: nodeId.optional(),
      })
      .strict(),
    history: z
      .array(
        z
          .object({
            at: moment,
            state: z.enum(nodeStates),
            note: z.string().max(160).optional(),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();
export type TaskNode = z.infer<typeof nodeSchema>;
export type LinkKind = "spawnedBy" | "answers" | "followsUp";
const fileSchema = z
  .object({
    version: z.literal(1),
    next: z.number().int().positive(),
    nodes: z.array(nodeSchema).max(400),
  })
  .strict();

/** The most nodes that the file keeps. Active nodes are always kept. */
const keptNodes = 300;
/** How many ended nodes the view shows at most. */
const finishedInView = 5;
export const graphViewLimit = 1_500;

/** Text of a source, safe to keep: one line, cut, and never a credential. */
export const graphText = (text: string, limit: number) => {
  const line = clean(text, limit);
  return looksSecretStrict(text) || looksSecretStrict(line)
    ? "[withheld: it held a credential]"
    : line;
};

/** What the real sources say now. Each part is absent where that source does not exist. */
export interface GraphSources {
  computer?: {
    snapshot: DesktopExecutionSnapshot | null;
    journal?: readonly JournalRequest[];
  };
  jobs?: readonly JobFacts[];
  routines?: readonly Routine[];
  reach?: readonly ReachRecord[];
  desk?: readonly DecisionRequest[];
}

/** The state of a computer request in the words of the graph. Null: no task. */
export function computerState(state: string): NodeState | null {
  switch (state) {
    case "queued":
    case "dispatching":
      return "queued";
    case "running":
    case "stopping":
      return "running";
    case "waiting_for_person":
    case "paused":
    // The result is not known: the owner must look and clear it.
    case "uncertain":
      return "waiting";
    case "completed":
      return "done";
    case "blocked":
      return "failed";
    case "canceled":
      return "canceled";
    case "idle":
    case "":
      return null;
    default:
      return "running";
  }
}

/** The state of a job in the words of the graph. */
export function jobState(job: JobFacts): NodeState {
  if (job.waiting) return "queued";
  switch (job.status) {
    case "completed":
      return "done";
    case "launch_failed":
    case "exited_without_result":
    case "unknown":
    case "retired_unknown":
      return "failed";
    case "launch_requested":
    case "awaiting_result":
      return "running";
    default:
      return job.done ? "done" : "running";
  }
}

/** The state of a call or text of the reach, from its newest event. */
function reachState(record: ReachRecord): NodeState {
  const last = record.events.at(-1)?.what ?? "";
  if (!last) return "queued";
  if (/(?:not_answered|failed|refused|missed|unknown)$/.test(last))
    return "failed";
  if (/(?:sent|answered|done|delivered)$/.test(last)) return "done";
  return "running";
}

const age = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
};
const clock = (at: number) => {
  const time = new Date(at);
  return `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
};
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 12);

export class TaskGraph {
  readonly file: string;
  private state: z.infer<typeof fileSchema>;
  private written = "";
  constructor(
    root: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = join(root, "agents", "task-graph.json");
    this.state = this.load();
    this.written = JSON.stringify(this.state);
  }

  private load(): z.infer<typeof fileSchema> {
    const empty = { version: 1 as const, next: 1, nodes: [] };
    try {
      if (!existsSync(this.file)) return empty;
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
        return empty;
      const parsed = fileSchema.safeParse(
        JSON.parse(readFileSync(this.file, "utf8")),
      );
      return parsed.success ? parsed.data : empty;
    } catch {
      return empty;
    }
  }

  /** Writes the graph when it changed. A write that fails keeps the graph in memory. */
  save() {
    this.prune();
    const text = JSON.stringify(this.state);
    if (text === this.written) return;
    try {
      secureWrite(this.file, this.state);
      this.written = text;
    } catch {
      // The next save tries again.
    }
  }

  private prune() {
    const nodes = this.state.nodes;
    if (nodes.length <= keptNodes) return;
    const ended = nodes
      .filter((node) => !isActive(node.state))
      .sort((left, right) => left.updatedAt - right.updatedAt);
    const drop = new Set(
      ended.slice(0, nodes.length - keptNodes).map((node) => node.id),
    );
    this.state.nodes = nodes.filter((node) => !drop.has(node.id));
  }

  nodes(): TaskNode[] {
    return this.state.nodes.map((node) => structuredClone(node));
  }
  get(id: string): TaskNode | null {
    const node = this.find(id);
    return node ? structuredClone(node) : null;
  }
  private find(id: string) {
    return this.state.nodes.find((node) => node.id === id.trim().toLowerCase());
  }
  bySource(source: string): TaskNode | null {
    const node = this.state.nodes.find((item) => item.source === source);
    return node ? structuredClone(node) : null;
  }

  private create(
    kind: NodeKind,
    title: string,
    state: NodeState,
    at: number,
    source?: string,
  ): TaskNode {
    const node: TaskNode = {
      id: `${prefix[kind]}${this.state.next++}`,
      kind,
      title: graphText(title, 160) || "(no words)",
      state,
      createdAt: at,
      updatedAt: at,
      ...(isActive(state) ? {} : { endedAt: at }),
      ...(source ? { source } : {}),
      links: {},
      history: [{ at, state }],
    };
    this.state.nodes.push(node);
    return node;
  }

  /** A request of the owner, in their words. It starts running: what it spawns sets its state. */
  addRequest(words: string): TaskNode {
    const node = this.create("request", words, "running", this.now());
    this.save();
    return structuredClone(node);
  }

  /** Ties one node to another: spawned by, answers, follows up. */
  link(id: string, kind: LinkKind, target: string): boolean {
    const node = this.find(id);
    const other = this.find(target);
    if (!node || !other || node === other) return false;
    node.links[kind] = other.id;
    node.updatedAt = Math.max(node.updatedAt, this.now());
    this.save();
    return true;
  }

  /** Sets the state of a node, with a note for its history. */
  settle(id: string, state: NodeState, note?: string) {
    const node = this.find(id);
    if (!node) return false;
    this.move(node, state, this.now(), note);
    this.save();
    return true;
  }

  private move(node: TaskNode, state: NodeState, at: number, note?: string) {
    if (node.state === state) return;
    node.state = state;
    node.updatedAt = Math.max(node.updatedAt, at);
    if (isActive(state)) delete node.endedAt;
    else node.endedAt = at;
    node.history.push({
      at,
      state,
      ...(note ? { note: graphText(note, 160) } : {}),
    });
    if (node.history.length > 12) node.history.splice(1, 1);
  }

  /** The node of one real record: made the first time, moved after that. */
  private upsert(
    source: string,
    kind: NodeKind,
    facts: {
      title: string;
      state: NodeState;
      at: number;
      detail?: string | undefined;
      result?: string | undefined;
      note?: string | undefined;
    },
  ): TaskNode {
    let node = this.state.nodes.find((item) => item.source === source);
    if (!node)
      node = this.create(kind, facts.title, facts.state, facts.at, source);
    else
      this.move(
        node,
        facts.state,
        Math.max(facts.at, node.updatedAt),
        facts.note,
      );
    if (facts.detail !== undefined) {
      const detail = graphText(facts.detail, 200);
      if (detail) node.detail = detail;
      else delete node.detail;
    }
    if (facts.result !== undefined) {
      const result = graphText(facts.result, 400);
      if (result) node.result = result;
    }
    return node;
  }

  /** One pass over the real sources. Nodes that a source no longer lists are settled. */
  observe(sources: GraphSources) {
    const now = this.now();
    if (sources.computer) this.observeComputer(sources.computer, now);
    if (sources.jobs)
      for (const job of sources.jobs.slice(0, 20))
        this.upsert(`job:${job.id}`, "job", {
          title: job.job,
          state: jobState(job),
          at: job.startedAt,
          ...(job.statusDetail ? { detail: job.statusDetail } : {}),
          ...(job.result ? { result: job.result } : {}),
        });
    if (sources.routines) {
      const listed = new Set<string>();
      for (const routine of sources.routines) {
        listed.add(`routine:${routine.id}`);
        this.upsert(`routine:${routine.id}`, "routine", {
          title: routine.request,
          state: routine.paused ? "waiting" : "queued",
          at: routine.createdAt,
          detail: `${scheduleText(routine)}${routine.paused ? ", paused" : `, next ${clock(routine.nextAt)}`}${routine.lastOutcome ? `, last: ${routine.lastOutcome.replace(/_/g, " ")}` : ""}`,
          note: routine.paused ? "paused" : undefined,
        });
        // The request that its last run started was spawned by the routine.
        const run = routine.lastRequestId
          ? this.state.nodes.find(
              (node) => node.source === `computer:${routine.lastRequestId}`,
            )
          : undefined;
        const self = this.state.nodes.find(
          (node) => node.source === `routine:${routine.id}`,
        );
        if (run && self && !run.links.spawnedBy) run.links.spawnedBy = self.id;
      }
      for (const node of this.state.nodes)
        if (
          node.kind === "routine" &&
          node.source &&
          !listed.has(node.source) &&
          isActive(node.state)
        )
          this.move(node, "canceled", now, "removed");
    }
    if (sources.reach)
      for (const record of sources.reach) {
        const last = record.events.at(-1);
        const node = this.upsert(`reach:${record.id}`, "reach", {
          title: `${record.origin === "routine" ? "a routine's" : "a"} ${record.kind} for the owner`,
          state: reachState(record),
          at: last?.at ?? record.seenAt,
          ...(last ? { detail: last.what.replace(/_/g, " ") } : {}),
        });
        const task = this.state.nodes.find(
          (item) => item.source === `computer:${record.requestId}`,
        );
        if (task && !node.links.spawnedBy) node.links.spawnedBy = task.id;
      }
    if (sources.desk) {
      const waiting = new Set<string>();
      for (const request of sources.desk) {
        waiting.add(`desk:${request.id}`);
        this.upsert(`desk:${request.id}`, "question", {
          title: `${request.agent} ${request.kind === "question" ? "asks" : "asks to run"}: ${request.summary}`,
          state: "waiting",
          at: request.createdAt,
          ...(request.options.length
            ? { detail: `choices: ${request.options.join(", ")}` }
            : {}),
        });
      }
      for (const node of this.state.nodes)
        if (
          node.source?.startsWith("desk:") &&
          !waiting.has(node.source) &&
          isActive(node.state)
        )
          this.move(node, "done", now, "no longer waits");
    }
    this.settleRequests(now);
    this.save();
  }

  private observeComputer(
    computer: NonNullable<GraphSources["computer"]>,
    now: number,
  ) {
    const snapshot = computer.snapshot;
    // The snapshot is the newer word on the request that it names.
    const live =
      snapshot?.configured &&
      snapshot.requestId &&
      computerState(snapshot.state) !== null
        ? snapshot.requestId
        : null;
    for (const request of computer.journal ?? []) {
      const state = computerState(request.state);
      if (!state || request.id === live) continue;
      this.upsert(`computer:${request.id}`, "computer", {
        title: request.goal,
        state,
        at: request.updatedAt,
        note: request.reason,
        ...(request.state === "uncertain"
          ? {
              detail:
                "Its result is not known. The owner looks at the screen, then clears it.",
            }
          : {}),
      });
    }
    // Only one question of the computer engine waits at a time: the one
    // that its snapshot asks now. Every other is over, also one of a request
    // that the engine no longer knows (after a restart).
    const settleQuestions = (keep: string | null, ended: NodeState | null) => {
      for (const node of this.state.nodes)
        if (
          node.kind === "question" &&
          node.source?.startsWith("question:") &&
          node.source !== keep &&
          isActive(node.state)
        )
          this.move(
            node,
            ended === "canceled" || ended === "failed" ? "canceled" : "done",
            now,
            ended && !isActive(ended)
              ? `the task ended ${ended}`
              : "no longer asked",
          );
    };
    if (!snapshot || !live) {
      if (snapshot?.configured) settleQuestions(null, null);
      return;
    }
    const state = computerState(snapshot.state)!;
    const journaled = computer.journal?.find((request) => request.id === live);
    const task = this.upsert(`computer:${live}`, "computer", {
      title: snapshot.goal ?? journaled?.goal ?? "a computer task",
      state,
      at: now,
      ...(isActive(state)
        ? { detail: snapshot.message }
        : { result: snapshot.message }),
      ...(snapshot.guidance?.length
        ? { note: `owner added: ${snapshot.guidance.at(-1)}` }
        : {}),
    });
    // The question that the task waits on is a node of its own, one for each
    // time it is asked: the same words asked again are a new question.
    const asked =
      snapshot.state === "waiting_for_person" && snapshot.waiting
        ? `question:${live}:${digest(snapshot.message)}`
        : null;
    let asking: string | null = null;
    if (asked) {
      const open = this.state.nodes.find(
        (node) =>
          node.kind === "question" &&
          isActive(node.state) &&
          (node.source === asked || node.source?.startsWith(`${asked}:`)),
      );
      const times = this.state.nodes.filter(
        (node) => node.source === asked || node.source?.startsWith(`${asked}:`),
      ).length;
      asking = open?.source ?? (times ? `${asked}:${times}` : asked);
      const question = this.upsert(asking, "question", {
        title: snapshot.message,
        state: "waiting",
        at: now,
        detail:
          snapshot.waiting === "approval"
            ? "It needs the owner's yes or no."
            : snapshot.waiting === "takeover"
              ? "The owner took over the Mac; it goes on when they say so."
              : "It asks the owner a question.",
      });
      question.links.spawnedBy ??= task.id;
      task.links.waitsOn = [
        ...new Set([...(task.links.waitsOn ?? []), question.id]),
      ].slice(-8);
    }
    // A question that it no longer asks was answered, or ended with the task.
    settleQuestions(asking, state);
  }

  /** A request of the owner takes the state of the work that it spawned. */
  private settleRequests(now: number) {
    for (const request of this.state.nodes) {
      if (request.kind !== "request") continue;
      const children = this.state.nodes.filter(
        (node) => node.links.spawnedBy === request.id,
      );
      if (!children.length) continue;
      const states = new Set(children.map((node) => node.state));
      const state: NodeState = states.has("running")
        ? "running"
        : states.has("waiting")
          ? "waiting"
          : states.has("queued")
            ? "queued"
            : states.has("failed")
              ? "failed"
              : [...states].every((item) => item === "canceled")
                ? "canceled"
                : "done";
      this.move(request, state, now);
    }
  }

  /** One node as one line of the view. */
  private line(node: TaskNode, now: number) {
    const when = isActive(node.state)
      ? age(now - node.createdAt)
      : `${age(now - (node.endedAt ?? node.updatedAt))} ago`;
    const links = [
      node.links.spawnedBy ? `from ${node.links.spawnedBy}` : "",
      node.links.followsUp ? `follows up ${node.links.followsUp}` : "",
      node.links.answers ? `answers ${node.links.answers}` : "",
      node.links.waitsOn?.length
        ? `waits on ${
            node.links.waitsOn
              .filter((id) => {
                const other = this.find(id);
                return other && isActive(other.state);
              })
              .join(", ") || "nothing now"
          }`
        : "",
    ]
      .filter(Boolean)
      .join("; ");
    const tail = isActive(node.state)
      ? node.detail
        ? ` (${clean(node.detail, 90)})`
        : ""
      : node.result
        ? ` -> "${clean(node.result, 90)}"`
        : node.detail
          ? ` (${clean(node.detail, 60)})`
          : "";
    return `- ${node.id} ${node.kind} ${node.state} ${when}: "${clean(node.title, 80)}"${tail}${links ? ` [${links}]` : ""}`;
  }

  /**
   * The view that goes with each request of the model: the active nodes,
   * newest first, then the last few that ended, within `limit` characters.
   */
  view(limit = graphViewLimit): string {
    const now = this.now();
    const active = this.state.nodes
      .filter((node) => isActive(node.state) && node.kind !== "request")
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const ended = this.state.nodes
      .filter((node) => !isActive(node.state) && node.kind !== "request")
      .sort(
        (left, right) =>
          (right.endedAt ?? right.updatedAt) - (left.endedAt ?? left.updatedAt),
      )
      .slice(0, finishedInView);
    if (!active.length && !ended.length) return "Tasks: none yet.";
    const lines: string[] = [];
    let used = 0;
    let left = 0;
    const add = (text: string) => {
      if (used + text.length + 1 > limit - 40) {
        left++;
        return;
      }
      lines.push(text);
      used += text.length + 1;
    };
    add(active.length ? "Active tasks:" : "Active tasks: none.");
    for (const node of active) add(this.line(node, now));
    if (ended.length) {
      add("Ended lately:");
      for (const node of ended) add(this.line(node, now));
    }
    if (left) lines.push(`(${left} more lines; the tasks tool shows them.)`);
    return lines.join("\n");
  }

  /** Every node, newest first, as lines: for the tasks tool with no id. */
  list(limit = 3_000): string {
    const now = this.now();
    const nodes = [...this.state.nodes].sort(
      (left, right) => right.updatedAt - left.updatedAt,
    );
    const lines: string[] = [];
    let used = 0;
    for (const node of nodes) {
      const text = this.line(node, now);
      if (used + text.length > limit) break;
      lines.push(text);
      used += text.length + 1;
    }
    return lines.join("\n") || "Tasks: none yet.";
  }

  /** One node in full: its words, its state and times, its links, its history and its result. */
  details(id: string): string | null {
    const node = this.find(id);
    if (!node) return null;
    const now = this.now();
    const named = (other: string | undefined) => {
      if (!other) return "";
      const found = this.find(other);
      return found
        ? `${found.id} (${found.kind}, ${found.state}: "${clean(found.title, 60)}")`
        : other;
    };
    const spawned = this.state.nodes
      .filter((item) => item.links.spawnedBy === node.id)
      .map((item) => named(item.id));
    return [
      `${node.id} ${node.kind}, ${node.state}. Started ${clock(node.createdAt)} (${age(now - node.createdAt)} ago), changed ${clock(node.updatedAt)}${node.endedAt ? `, ended ${clock(node.endedAt)}` : ""}.`,
      `Title: "${node.title}"`,
      node.detail ? `Now: ${node.detail}` : "",
      node.result ? `Result: ${node.result}` : "",
      node.links.spawnedBy ? `Spawned by: ${named(node.links.spawnedBy)}` : "",
      node.links.followsUp ? `Follows up: ${named(node.links.followsUp)}` : "",
      node.links.answers ? `Answers: ${named(node.links.answers)}` : "",
      node.links.waitsOn?.length
        ? `Waits on: ${node.links.waitsOn.map(named).join(", ")}`
        : "",
      spawned.length ? `Spawned: ${spawned.join(", ")}` : "",
      `History: ${node.history.map((entry) => `${clock(entry.at)} ${entry.state}${entry.note ? ` (${entry.note})` : ""}`).join("; ")}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  /** The newest active node of a kind, or null. */
  activeOf(kind: NodeKind): TaskNode | null {
    const node = this.state.nodes
      .filter((item) => item.kind === kind && isActive(item.state))
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    return node ? structuredClone(node) : null;
  }
}
