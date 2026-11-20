import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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
 * The job is the person's own sentence. It travels in a file, never on a
 * command line, so no spoken word can become a shell command. The session
 * writes a short answer to a file, and that answer is what ClawdTime says.
 */
export interface JobFacts {
  id: string;
  /** The job in the person's words, cut for a list. */
  job: string;
  startedAt: number;
  done: boolean;
  /** The answer that the session wrote, as plain text. null while it works. */
  result: string | null;
}

export interface JobPort {
  /** Starts one job. `said` is one sentence that can be spoken. */
  start(job: string): Promise<{ ok: boolean; said: string }>;
  /** The newest jobs first. */
  recent(limit?: number): JobFacts[];
}

/** The coding agents that can take a job, and how each takes its first message. */
const agents = {
  claude: (prompt: string) => `exec claude "$(cat ${prompt})"`,
  codex: (prompt: string) => `exec codex "$(cat ${prompt})"`,
} as const;
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
/** A job in words only: one paragraph, no control character, at most 2000 characters. */
export const cleanJob = (job: string) =>
  job.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim().slice(0, 2000);

const idPattern = /^[0-9]{8}T[0-9]{6}-[0-9a-z]{4}$/;
/** How long a job with no answer still counts as running. */
const runningMs = 2 * 60 * 60 * 1000;

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
      /** How many jobs may run at one time. */
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
    const running = this.recent(50).filter(
      (item) => !item.done && this.now() - item.startedAt < runningMs,
    );
    if (running.length >= this.limit)
      return {
        ok: false,
        said: `${running.length} jobs still run. Ask for a result, or wait for one to finish.`,
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
    writeFileSync(
      script,
      `#!/bin/zsh\ncd ${quoted(this.project)} || exit 1\n${agents[this.agent](quoted(prompt))}\n`,
      { mode: 0o700 },
    );
    chmodSync(script, 0o700);
    const opened = await this.run(
      "/usr/bin/open",
      ["-a", this.terminal, script],
      10_000,
    );
    if (opened.status !== 0)
      return {
        ok: false,
        said: "The terminal window for the job did not open on this Mac.",
      };
    return {
      ok: true,
      said: "I started a new session for that job in a terminal window. I will have its answer when it is done.",
    };
  }

  recent(limit = 10): JobFacts[] {
    if (!existsSync(this.folder) || !lstatSync(this.folder).isDirectory())
      return [];
    const found: JobFacts[] = [];
    for (const id of readdirSync(this.folder)
      .filter((name) => idPattern.test(name))
      .sort()
      .reverse()
      .slice(0, Math.max(1, Math.min(limit, 50)))) {
      const directory = join(this.folder, id);
      const read = (name: string, max: number) => {
        try {
          const file = join(directory, name);
          // A link is never followed: the answer is a regular file of this folder.
          if (!lstatSync(file).isFile()) return null;
          return readFileSync(file, "utf8").slice(0, max);
        } catch {
          return null;
        }
      };
      const prompt = read("prompt.txt", 4000);
      if (prompt === null) continue;
      const answer = read("result.md", 20_000);
      const startedAt = Date.parse(
        `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(9, 11)}:${id.slice(11, 13)}:${id.slice(13, 15)}Z`,
      );
      found.push({
        id,
        job: cleanJob(prompt.split("\n\nWhen you are done,")[0] ?? "").slice(
          0,
          300,
        ),
        startedAt: Number.isFinite(startedAt) ? startedAt : 0,
        done: answer !== null,
        result:
          answer === null
            ? null
            : plainAnswer(answer) || "The session wrote an empty answer.",
      });
    }
    return found;
  }
}
