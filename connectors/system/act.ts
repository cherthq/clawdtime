/**
 * The actions on a process: quit an app nicely, force quit a process, and
 * restart an app. They go through the ask policy of computer use
 * (`askPolicy` in guards.ts):
 *
 * - A nice quit of an app acts at once: the app can save, or show its own
 *   save sheet, as with Quit in the Dock. So does a restart, which is a nice
 *   quit and an open.
 * - A force quit, and a stop of a process that is no app, lose what is not
 *   saved: the `unsaved` row. They ask first, unless the owner's own words
 *   ask to lose the changes ("without saving"), or the owner's trust is on.
 *   A yes counts only when it is the owner's own clear yes, by the strict
 *   reader of the chat, after the question, within five minutes, for the
 *   same process (its pid and its start time), and only when the caller
 *   says that the yes is for this question: a plain yes answers the newest
 *   question that the owner saw, and an older one is asked again.
 * - Never: launchd, the kernel, WindowServer, loginwindow, a process of
 *   another user, and ClawdTime itself (its own process, those it runs in,
 *   those it started, and its apps and entry points).
 */
import { explicitApprovalNo, explicitApprovalYes } from "../agents/call.js";
import { askPolicy, asksToLose, clean } from "../computer/guards.js";
import { label } from "./look.js";
import { parseStart } from "./parse.js";
import type { ProcessView, SystemProbes } from "./probes.js";
import { parseName, parsePid } from "./words.js";

export const processActions = ["quit", "force_quit", "restart"] as const;
export type ProcessAction = (typeof processActions)[number];

/** How long a question about a force quit holds for the owner's yes. */
export const askHoldsMs = 5 * 60_000;
const quitWaitMs = 5000;
const restartWaitMs = 8000;
const termWaitMs = 3000;
const killWaitMs = 2000;
const pollMs = 250;

/** Parts of macOS that keep the Mac running. */
const neverTouched = new Set([
  "kernel_task",
  "launchd",
  "WindowServer",
  "loginwindow",
]);
/** An app or a command of ClawdTime by its executable. */
const clawdtimeExecutable = /\/ClawdTime[^/]*\.app\/|(?:^|\/)clawdtime[^/]*$/i;
/** A command line that runs an entry point of ClawdTime from its folder. */
const clawdtimeEntry =
  /clawdtime\S*\/(?:scripts\/task-[\w-]+|cli\/(?:main|index|task-desktop)|line\/[\w-]+|dist\/[\w/-]+)\.[cm]?[jt]s\b|clawdtime\S*\/(?:media|gateway)\/[\w-]+\.py\b/i;

/** ClawdTime's own process tree: itself, what it runs in, and what it started. */
function ownTree(all: ProcessView[], self: { pid: number; ppid: number }) {
  const byPid = new Map(all.map((row) => [row.pid, row]));
  const inside = new Set<number>();
  for (
    let pid = self.ppid, guard = 0;
    pid > 1 && !inside.has(pid) && guard < 32;
    guard++
  ) {
    inside.add(pid);
    pid = byPid.get(pid)?.ppid ?? 0;
  }
  const started = new Set<number>([self.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of all)
      if (started.has(row.ppid) && !started.has(row.pid)) {
        started.add(row.pid);
        changed = true;
      }
  }
  return { inside, started };
}

/** Why this process is never touched here, or null. */
export function protectedReason(
  row: ProcessView,
  all: ProcessView[],
  command: string,
  self: { pid: number; ppid: number },
): string | null {
  if (row.pid <= 1 || neverTouched.has(row.name))
    return `${label(row)} is a part of macOS that keeps the Mac running. ClawdTime never ends it.`;
  const tree = ownTree(all, self);
  if (tree.inside.has(row.pid))
    return `ClawdTime runs inside ${label(row)}: ending it would end ClawdTime. ClawdTime does not end itself.`;
  if (
    tree.started.has(row.pid) ||
    clawdtimeExecutable.test(row.path) ||
    clawdtimeEntry.test(command)
  )
    return `${label(row)} is a part of ClawdTime. ClawdTime does not end itself: use Stop, or quit ClawdTime from its menu.`;
  return null;
}

/** A question about a process that waits for the owner's yes or no. */
export interface ProcessAsk {
  /** The action, the pid and the start time of the process. */
  key: string;
  /** When it was asked, or asked again. */
  at: number;
  question: string;
}

/** The owner's newest words, for an action that may need their yes. */
export interface OwnerWords {
  words: string;
  /** When they came: a yes is read from them only for a question that came before. */
  at: number;
  /** False when these words decide nothing for this question: they answer another one. */
  mayDecide?: (ask: ProcessAsk) => boolean;
  /** Hears when the words were used as a yes. */
  used?: () => void;
}

export type ActVerdict =
  | { kind: "act"; trusted: boolean }
  | { kind: "ask"; question: string }
  | { kind: "refuse"; reason: string };

/** The ask policy for one action on one process that may be touched. */
export function actVerdict(
  row: ProcessView,
  action: ProcessAction,
  context: { uid: number; trust: boolean; owner: string },
): ActVerdict {
  if (row.uid !== context.uid)
    return {
      kind: "refuse",
      reason: `${label(row).replace(/ \(app\)$/, "")} runs as another user (${row.user}), so ClawdTime cannot end it.`,
    };
  if (action === "restart" && !row.isApp)
    return {
      kind: "refuse",
      reason: `Not done: only an app restarts here, and ${row.name} is no app. Quit it, and what started it may start it again.`,
    };
  if (row.isApp && action !== "force_quit")
    return { kind: "act", trusted: false };
  if (context.trust) return { kind: "act", trusted: true };
  if (asksToLose(context.owner)) return { kind: "act", trusted: false };
  const name = row.isApp ? row.app! : row.name;
  return {
    kind: "ask",
    question:
      action === "force_quit"
        ? `Force quit ${name} (pid ${row.pid})? ${askPolicy.unsaved.reason} Say yes or no.`
        : `Stop ${name} (pid ${row.pid})? It is no app, so it cannot save first. ${askPolicy.unsaved.reason} Say yes or no.`,
  };
}

/** The JavaScript for Automation that asks an app to quit, as Quit in the Dock does. */
export const quitScript = (pid: number) =>
  `ObjC.import("AppKit"); var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); app.isNil() ? "gone" : (app.terminate ? "asked" : "refused")`;

export class ProcessDesk {
  /** The questions that wait for the owner's yes: by action, pid and start. */
  private readonly asks = new Map<string, { at: number; question: string }>();

  constructor(
    readonly probes: SystemProbes,
    private readonly options: { trust: boolean },
  ) {}

  get trust() {
    return this.options.trust;
  }

  private forget(now: number) {
    for (const [old, ask] of this.asks)
      if (now - ask.at > askHoldsMs) this.asks.delete(old);
  }

  /** The questions that wait for the owner's yes now, oldest first. */
  pending(): ProcessAsk[] {
    this.forget(this.probes.host.now());
    return [...this.asks]
      .map(([key, ask]) => ({ key, ...ask }))
      .sort((left, right) => left.at - right.at);
  }

  /** When a process started, as ps says it, to tell a pid from a new one with the same number. */
  private async started(pid: number) {
    const result = await this.probes.host.exec(
      "/bin/ps",
      ["-ww", "-o", "lstart=,command=", "-p", String(pid)],
      { timeoutMs: 2000, maxBytes: 64 * 1024 },
    );
    return parseStart(result.stdout);
  }

  /** Waits until the process ends or the time is over. True when it ended. */
  private async ended(pid: number, ms: number) {
    const host = this.probes.host;
    for (let waited = 0; ; waited += pollMs) {
      if (!host.alive(pid)) return true;
      if (waited >= ms) return false;
      await host.sleep(pollMs);
    }
  }

  private async open(target: string, background: boolean) {
    const result = await this.probes.host.exec(
      "/usr/bin/open",
      [...(background ? ["-g"] : []), "-a", target],
      { timeoutMs: 10_000, maxBytes: 64 * 1024 },
    );
    return result.code === 0;
  }

  /** Asks an app to quit nicely. "asked", or why it could not. */
  private async askToQuit(pid: number) {
    const result = await this.probes.host.exec(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", quitScript(pid)],
      { timeoutMs: 5000, maxBytes: 64 * 1024 },
    );
    const said = result.stdout.trim();
    return result.code === 0 && said === "asked" ? "asked" : said || "failed";
  }

  /**
   * One action of the owner's request. `owner` is their newest words and
   * when they came: a yes is read from them only for a question that came
   * before, and `used` hears when it was. `background`: open an app again
   * behind the window in front, for a computer task that runs. It never
   * throws.
   */
  async act(
    input: { action: unknown; pid?: unknown; name?: unknown },
    owner: OwnerWords,
    options: { background: boolean },
  ): Promise<string> {
    const action = processActions.find((item) => item === input.action);
    if (!action)
      return "Not done: the action must be quit, force_quit or restart.";
    const hasPid =
      input.pid !== undefined && input.pid !== null && input.pid !== "";
    const pid = hasPid ? parsePid(input.pid) : null;
    if (hasPid && !pid)
      return "Not done: the pid does not parse. Give the number of one process.";
    const hasName =
      input.name !== undefined && input.name !== null && input.name !== "";
    const name = hasName ? parseName(input.name) : null;
    if (hasName && !name)
      return "Not done: the name does not parse. Give the plain name of an app or a process.";
    if (!pid && !name)
      return "Not done: say which process, by its name or its pid.";
    try {
      return await this.run(action, { pid, name }, owner, options);
    } catch {
      return "Not done: the process level of this Mac did not answer. Nothing was changed.";
    }
  }

  private async run(
    action: ProcessAction,
    target: { pid: number | null; name: string | null },
    owner: OwnerWords,
    options: { background: boolean },
  ): Promise<string> {
    const host = this.probes.host;
    const found = await this.probes.find(target);
    if (found.kind === "none") {
      // A restart of an app that does not run is an open.
      if (action === "restart" && target.name && !target.pid)
        return (await this.open(target.name, options.background))
          ? `${target.name} did not run, so it is opening now.`
          : `No app named ${target.name} was found, so nothing opened.`;
      return `Not done: ${found.reason}`;
    }
    if (found.kind === "many")
      return `Not done: more than one process fits: ${found.rows
        .slice(0, 8)
        .map((row) => `${label(row)} pid ${row.pid}`)
        .join("; ")}. Say which one by its pid.`;
    const { row, all } = found;
    const commands = await this.probes
      .commands()
      .catch(() => new Map<number, string>());
    const guarded = protectedReason(
      row,
      all,
      commands.get(row.pid) ?? "",
      host.self,
    );
    if (guarded) return guarded;
    const verdict = actVerdict(row, action, {
      uid: host.uid,
      trust: this.options.trust,
      owner: owner.words,
    });
    if (verdict.kind === "refuse") return verdict.reason;
    const start = await this.started(row.pid);
    if (verdict.kind === "ask") {
      const key = `${action}|${row.pid}|${start?.started ?? ""}`;
      const now = host.now();
      this.forget(now);
      const waiting = this.asks.get(key);
      if (!waiting) {
        this.asks.set(key, { at: now, question: verdict.question });
        return `Not done yet: this needs the owner's yes. Ask them in these words: "${verdict.question}" When they say yes, call process_act again with the same action and target.`;
      }
      const words = clean(owner.words, 600);
      const theirs = owner.at > waiting.at;
      const said =
        theirs &&
        (explicitApprovalYes.test(words) || explicitApprovalNo.test(words));
      if (said && owner.mayDecide && !owner.mayDecide({ key, ...waiting })) {
        // The yes or no is for another question. This one is asked again,
        // so it is the newest one when the owner answers next.
        waiting.at = now;
        return `Not done: the owner's "${clean(words, 40)}" answers another question, so it decides nothing here. This one still waits: ask it again in these words: "${waiting.question}" When they say yes, call process_act again with the same action and target.`;
      }
      if (theirs && explicitApprovalNo.test(words)) {
        this.asks.delete(key);
        return "The owner said no, so nothing was done.";
      }
      if (!theirs || !explicitApprovalYes.test(words))
        return `Waiting for the owner's clear yes or no to: "${waiting.question}"`;
      // The yes is used once.
      this.asks.delete(key);
      owner.used?.();
    }
    const done = await this.perform(action, row, options.background);
    return verdict.kind === "act" && verdict.trusted
      ? `${done} The owner's trust is on, so no question was asked.`
      : done;
  }

  private async perform(
    action: ProcessAction,
    row: ProcessView,
    background: boolean,
  ): Promise<string> {
    const host = this.probes.host;
    const name = row.isApp ? row.app! : row.name;
    if (action === "force_quit" || !row.isApp) {
      const signal = action === "force_quit" ? "SIGKILL" : "SIGTERM";
      const sent = host.signal(row.pid, signal);
      if (sent === "gone") return `${name} (pid ${row.pid}) had already ended.`;
      if (sent === "denied")
        return `macOS did not allow ClawdTime to end ${name} (pid ${row.pid}).`;
      const gone = await this.ended(
        row.pid,
        signal === "SIGKILL" ? killWaitMs : termWaitMs,
      );
      if (signal === "SIGKILL")
        return gone
          ? `Force quit ${name} (pid ${row.pid}). It no longer runs.`
          : `Force quit ${name} (pid ${row.pid}), and it still runs after ${killWaitMs / 1000} s: it may wait on the system.`;
      return gone
        ? `Stopped ${name} (pid ${row.pid}).`
        : `Sent ${name} (pid ${row.pid}) the signal to stop. It still runs after ${termWaitMs / 1000} s; a force quit ends it at once.`;
    }
    const asked = await this.askToQuit(row.pid);
    if (asked !== "asked")
      return asked === "gone"
        ? `${name} had already ended, or macOS does not know it as an app.`
        : `macOS did not let ClawdTime ask ${name} to quit. Quit it on the screen, or ask for a force quit.`;
    const wait = action === "restart" ? restartWaitMs : quitWaitMs;
    const gone = await this.ended(row.pid, wait);
    if (action === "quit")
      return gone
        ? `${name} quit.`
        : `Asked ${name} to quit. It still runs after ${wait / 1000} s: it may show a save sheet, or not respond. A force quit ends it, and what it did not save is lost.`;
    if (!gone)
      return `${name} did not quit in ${wait / 1000} s: it may show a save sheet, or not respond (${Math.round(row.cpu)} percent CPU). It was not started again. A force quit ends it, and what it did not save is lost.`;
    return (await this.open(row.appPath ?? name, background))
      ? `Restarted ${name}: it quit, and it is opening again.`
      : `${name} quit, but it did not open again. Open it yourself, or ask again.`;
  }
}
