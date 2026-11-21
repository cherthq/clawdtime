import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { realRunner, type Runner } from "./focus.js";
import { looksSecret } from "./memory.js";

/**
 * Jobs: work that ClawdTime hands to a coding agent on this Mac.
 *
 * ClawdTime answers and decides. It does not build, run or browse by itself.
 * When the person asks for work that none of its own tools does, it starts a
 * new session of the person's own coding agent, in a terminal window that the
 * person can see, with the job as its first message. That session works under
 * the person's own agent settings: ClawdTime adds no permission. It appears on
 * the board as every other session does, so it can be watched, answered and
 * shown.
 *
 * The job is the person's own sentence. It is written to a file and is never
 * part of a shell command, so no spoken word can become one. It reaches the
 * agent as one argument: other users of this Mac can see that argument in the
 * process list while the session runs. The session writes a short answer to a
 * file, and that answer is what ClawdTime says.
 */
export type JobStatus =
  | "launch_requested"
  | "awaiting_result"
  | "launch_failed"
  | "exited_without_result"
  | "unknown"
  | "retired_unknown"
  | "completed";

export interface JobFacts {
  id: string;
  /** The job in the person's words, cut for a list. */
  job: string;
  startedAt: number;
  done: boolean;
  /** A launch or a missing answer is never evidence of progress. */
  status?: JobStatus;
  statusDetail?: string;
  /** The answer that the session wrote, as one plain line for speech; null when unresolved. */
  result: string | null;
  /** The same answer with its lines kept, for a text message. */
  text?: string | null;
}

export interface JobPort {
  /** Starts one job. `said` is one sentence that can be spoken. */
  start(job: string): Promise<{ ok: boolean; said: string }>;
  /** The newest jobs first. */
  recent(limit?: number): JobFacts[];
}

/** The coding agents that can take a job, and how each takes its first message. */
const agents = {
  claude: (prompt: string) => `claude "$(cat ${prompt})"`,
  codex: (prompt: string) => `codex "$(cat ${prompt})"`,
} as const;
/** What the answer file says when the coding agent is not on this Mac: the job then ends at once. */
const missingAgent = (agent: string) =>
  `The coding agent ${agent} is not installed on this Mac, so the job did not start.`;
const secretAnswer =
  "The answer holds a password or a key, so it is not said here. Read it in the terminal window of the job.";
export type JobAgent = keyof typeof agents;
export const jobAgents = Object.keys(agents) as JobAgent[];

/** One word of a shell script, in single quotes. A quote in a path cannot end them. */
const quoted = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** Plain text for speech and for a text message: no terminal colors, no control characters. */
export function plainAnswer(text: string, limit = 1200) {
  const plain = text
    .replace(ANSI, "")
    .replace(/\p{C}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > limit ? `${plain.slice(0, limit)} ... (cut)` : plain;
}
/** The answer with its lines kept: a link stays on a line of its own. */
export function plainLines(text: string, limit = 3500) {
  const plain = text
    .replace(ANSI, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\P{C}\n]/gu, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return plain.length > limit ? `${plain.slice(0, limit)}\n... (cut)` : plain;
}
/**
 * A job in words only: one paragraph, no control character, at most 2000
 * characters. It never starts with a dash, which the agent's command would
 * read as an option.
 */
export const cleanJob = (job: string) =>
  job
    .replace(/\p{C}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-\s]+/, "")
    .slice(0, 2000);

const idPattern = /^[0-9]{8}T[0-9]{6}-[0-9a-z]{4}$/;
/** A missing result remains unresolved until an operator explicitly retires it. */
export function jobStatusDetail(
  job: Pick<JobFacts, "done" | "status" | "statusDetail">,
) {
  if (job.statusDetail) return job.statusDetail;
  if (job.done) return "The session returned an answer.";
  return "No result has arrived. Whether the session is working, waiting, or stuck is unverified.";
}

export class Jobs implements JobPort {
  private readonly folder: string;
  private readonly now: () => number;
  private readonly run: Runner;
  private readonly project: string;
  private readonly agent: JobAgent;
  private readonly terminal: string;
  private readonly limit: number;
  constructor(
    root: string,
    options: {
      /** The folder that the session works in. */
      project: string;
      now?: () => number;
      run?: Runner;
      agent?: JobAgent;
      /** The terminal application that opens the session's window. */
      terminal?: string;
      /** How many unresolved jobs may occupy the launch queue. */
      limit?: number;
    },
  ) {
    this.folder = join(root, "agents", "jobs");
    this.now = options.now ?? Date.now;
    this.run = options.run ?? realRunner;
    this.project = options.project;
    this.agent = options.agent ?? "claude";
    this.terminal = options.terminal ?? "Terminal";
    this.limit = options.limit ?? 4;
  }

  async start(job: string): Promise<{ ok: boolean; said: string }> {
    const text = cleanJob(job);
    if (text.length < 8)
      return { ok: false, said: "The job was not clear. Ask for it again." };
    // A credential is never written to a job file: the person types it where it is needed.
    if (looksSecret(text))
      return {
        ok: false,
        said: "That holds a password or a key. I did not start a job with it. Give the job without the secret.",
      };
    const running = this.readRecords(this.recordIds()).filter(
      (item) => !item.done && item.status !== "retired_unknown",
    );
    if (running.length >= this.limit)
      return {
        ok: false,
        said: `${running.length} jobs have unresolved outcomes. Inspect them before starting another job; missing answers do not prove they are running.`,
      };
    const stamp = new Date(this.now())
      .toISOString()
      .replace(/[-:]/g, "")
      .slice(0, 15);
    const id = `${stamp}-${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;
    const directory = join(this.folder, id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(this.folder, 0o700);
    const result = join(directory, "result.md");
    const prompt = join(directory, "prompt.txt");
    writeFileSync(
      prompt,
      `${text}\n\nWhen you are done, write your answer to the file ${result} as plain text, six short lines at most. It is read aloud on a phone call or sent as a text message, so use plain words and no table. When the job makes something to open, such as a link, put it on a line of its own.\n`,
      { mode: 0o600 },
    );
    const script = join(directory, "start.command");
    // Only paths that this program made stand in the script. The job stays in its file.
    // When the agent is missing, the script writes that as the answer: the
    // job then ends with a true sentence and releases its queue place.
    writeFileSync(
      script,
      [
        "#!/bin/zsh",
        "umask 077",
        "setopt NO_CLOBBER",
        `[[ ! -e ${quoted(join(directory, "retired.json"))} ]] || { print -r -- 'This job was retired; it will not be replayed.'; exit 1; }`,
        // An old script cannot replay the job, even after its agent exits.
        `printf '{"version":1,"pid":%s}\\n' "$$" > ${quoted(join(directory, "launched.json"))} || { print -r -- 'This job was already launched; it will not be replayed.'; exit 1; }`,
        `job_exit_receipt() { local job_exit=$?; printf '{"version":1,"exitCode":%s}\\n' "$job_exit" > ${quoted(join(directory, "exited.json"))}; }`,
        "trap job_exit_receipt EXIT",
        `cd ${quoted(this.project)} || exit 1`,
        `command -v ${this.agent} >/dev/null 2>&1 || { print -r -- ${quoted(missingAgent(this.agent))} > ${quoted(result)}; exit 1; }`,
        agents[this.agent](quoted(prompt)),
        "exit $?",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    chmodSync(script, 0o700);
    writeFileSync(
      join(directory, "requested.json"),
      JSON.stringify({ version: 1, at: this.now() }),
      { mode: 0o600, flag: "wx" },
    );
    const opened = await this.run(
      "/usr/bin/open",
      ["-a", this.terminal, script],
      10_000,
    );
    if (opened.status !== 0) {
      writeFileSync(
        join(directory, "launch-failed.json"),
        JSON.stringify({ version: 1, at: this.now() }),
        { mode: 0o600, flag: "wx" },
      );
      return {
        ok: false,
        said: "The terminal launch failed. Whether the agent started is unverified; inspect this job before retrying.",
      };
    }
    return {
      ok: true,
      said: "I requested a terminal session for that job. Its progress is unverified until the session reports a result.",
    };
  }

  /** Retire bookkeeping only. Never kill a process, replay work, or certify its outcome. */
  retire(id: string, reason: string): string {
    const detail = cleanJob(reason).slice(0, 400);
    if (!idPattern.test(id) || detail.length < 8 || looksSecret(detail))
      throw new Error(
        "Retirement needs an exact job id and a non-secret reason of at least eight characters.",
      );
    const directory = join(this.folder, id);
    if (!lstatSync(directory).isDirectory())
      throw new Error("The job is not a real directory.");
    const job = this.readRecords([id])[0];
    if (!job) throw new Error("That job record could not be read.");
    if (job.status === "retired_unknown")
      return "This job is already retired. Its outcome remains unknown; no process was stopped and no action was replayed.";
    if (job.done)
      throw new Error(
        "The job already has a result; retirement will not overwrite it.",
      );
    writeFileSync(
      join(directory, "retired.json"),
      JSON.stringify({
        version: 1,
        at: this.now(),
        reason: detail,
        outcome: "unknown",
      }),
      { mode: 0o600, flag: "wx" },
    );
    return "Retired this job from the launch queue. Its outcome remains unknown. This did not stop the terminal process or replay any action; the original records are preserved.";
  }

  recent(limit = 10): JobFacts[] {
    return this.readRecords(
      this.recordIds().slice(0, Math.max(1, Math.min(limit, 50))),
    );
  }

  /** Display limits must never age an unresolved outcome out of the launch queue. */
  private recordIds(): string[] {
    if (!existsSync(this.folder) || !lstatSync(this.folder).isDirectory())
      return [];
    return readdirSync(this.folder)
      .filter((name) => idPattern.test(name))
      .sort()
      .reverse();
  }

  private readRecords(ids: string[]): JobFacts[] {
    const found: JobFacts[] = [];
    for (const id of ids) {
      const directory = join(this.folder, id);
      // A link is never followed: a job is a real folder here, with regular files.
      try {
        if (!lstatSync(directory).isDirectory()) continue;
      } catch {
        continue;
      }
      /** At most max bytes from the start of the file, however large the file is. */
      const read = (name: string, max: number) => {
        try {
          const file = join(directory, name);
          const facts = lstatSync(file);
          if (!facts.isFile()) return null;
          const handle = openSync(file, "r");
          try {
            const buffer = Buffer.alloc(Math.min(max, facts.size));
            const count = readSync(handle, buffer, 0, buffer.length, 0);
            return buffer.subarray(0, count).toString("utf8");
          } finally {
            closeSync(handle);
          }
        } catch {
          return null;
        }
      };
      const prompt = read("prompt.txt", 8000);
      if (prompt === null) continue;
      const receipt = (name: string): Record<string, unknown> | null => {
        try {
          const value: unknown = JSON.parse(read(name, 2000) ?? "null");
          return value !== null &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            (value as Record<string, unknown>).version === 1
            ? (value as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      };
      const retired = receipt("retired.json");
      const launched = receipt("launched.json");
      const exited = receipt("exited.json");
      const failed = receipt("launch-failed.json");
      const requested = receipt("requested.json");
      const written = read("result.md", 40_000);
      // A key that the session wrote into its answer is not said aloud or sent as a text.
      const answer =
        written !== null && looksSecret(written) ? secretAnswer : written;
      const startedAt = Date.parse(
        `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(9, 11)}:${id.slice(11, 13)}:${id.slice(13, 15)}Z`,
      );
      // An id from the future is not a job of this program.
      if (Number.isFinite(startedAt) && startedAt > this.now() + 60_000)
        continue;
      const retiredUnknown = retired?.outcome === "unknown";
      const status: JobStatus = retiredUnknown
        ? "retired_unknown"
        : answer !== null
          ? "completed"
          : exited &&
              Number.isInteger(exited.exitCode) &&
              (exited.exitCode as number) >= 0 &&
              (exited.exitCode as number) <= 255
            ? "exited_without_result"
            : failed
              ? "launch_failed"
              : launched &&
                  Number.isInteger(launched.pid) &&
                  (launched.pid as number) > 0
                ? "awaiting_result"
                : requested
                  ? "launch_requested"
                  : "unknown";
      const statusDetail =
        status === "retired_unknown"
          ? `Retired from the queue with unknown outcome. Retirement does not stop its process.${answer !== null ? " A later answer is preserved in the job folder, but does not erase the unknown outcome." : ""}`
          : status === "completed"
            ? "The session returned an answer; its effects have not been independently verified."
            : status === "exited_without_result"
              ? `The launcher exited with code ${exited!.exitCode}, without a result. Its effects are unknown; do not replay it blindly.`
              : status === "launch_failed"
                ? "The terminal launch failed. Whether its agent started is unverified."
                : status === "awaiting_result"
                  ? "The launcher started, but no result has arrived. Whether the session is working, waiting, or stuck is unverified."
                  : status === "launch_requested"
                    ? "A terminal launch was requested, but the launcher has not acknowledged starting."
                    : "This older job has no launch or completion receipt. Whether it started, is waiting, or is stuck is unknown.";
      found.push({
        id,
        status,
        statusDetail,
        job: cleanJob(prompt.split("\n\nWhen you are done,")[0] ?? "").slice(
          0,
          300,
        ),
        startedAt: Number.isFinite(startedAt) ? startedAt : 0,
        done: answer !== null && !retiredUnknown,
        result:
          answer === null || retiredUnknown
            ? null
            : plainAnswer(answer) || "The session wrote an empty answer.",
        text:
          answer === null || retiredUnknown
            ? null
            : plainLines(answer) || "The session wrote an empty answer.",
      });
    }
    return found;
  }
}
