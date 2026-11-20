import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { secureWrite } from "../shared/state.js";
import { countStates, order } from "./board.js";
import { requestSchema, type DecisionRequest } from "./decisions.js";
import type { Runner } from "./focus.js";
import { cleanInput } from "./input.js";
import {
  boardSnapshotSchema,
  hostNameSchema,
  type AgentSession,
  type BoardSnapshot,
  type HostStatus,
} from "./types.js";

/**
 * Remote Macs. A Mac mini that runs agents is supervised from this Mac over
 * ssh: this Mac runs ClawdTime's own command there and reads its answer.
 * ClawdTime installs nothing on the remote Mac and keeps no connection open.
 * ssh never asks for a password here: a host that needs one fails at once.
 */
const safe = /^[A-Za-z0-9_.@][A-Za-z0-9_.@-]*$/;
export const hostSchema = z
  .object({
    name: hostNameSchema,
    /** A host alias of the ssh config, or user@host. It never starts with a dash. */
    ssh: z.string().max(253).regex(safe),
    /** The ClawdTime command on that Mac: a bare name or an absolute path. */
    command: z
      .string()
      .max(400)
      .refine(
        (value) =>
          safe.test(value) ||
          (value.startsWith("/") &&
            value
              .slice(1)
              .split("/")
              .every((part) => safe.test(part))),
      ),
    addedAt: z.number().int().nonnegative(),
  })
  .strict();
export type RemoteHost = z.infer<typeof hostSchema>;

/** The remote Macs that the person added, in one owner-only file. */
export class HostBook {
  private readonly file: string;
  constructor(root: string) {
    this.file = join(root, "agents", "hosts.json");
  }
  list(): RemoteHost[] {
    try {
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.size > 65_536) return [];
      return z
        .array(hostSchema)
        .max(16)
        .parse(JSON.parse(readFileSync(this.file, "utf8")));
    } catch {
      // No file, or one that cannot be read: no remote Mac is asked.
      return [];
    }
  }
  get(name: string | null | undefined) {
    return this.list().find((host) => host.name === name) ?? null;
  }
  /** Adds a host, or replaces the one with the same name. */
  add(input: { name: string; ssh: string; command?: string; at: number }) {
    const parsed = hostSchema.safeParse({
      name: input.name,
      ssh: input.ssh,
      command: input.command ?? "clawdtime",
      addedAt: input.at,
    });
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      throw new Error(
        field === "name"
          ? 'A host name is 1 to 16 characters: small letters, digits and "-". It cannot be "local" or start with "bg-".'
          : field === "ssh"
            ? 'The ssh target is a host alias or user@host: letters, digits, ".", "_", "@" and "-", with no "-" at the start. For a port or a key, make an alias in ~/.ssh/config.'
            : "The command is a bare name or an absolute path, with no spaces.",
      );
    }
    const others = this.list().filter((host) => host.name !== input.name);
    if (others.length >= 16) throw new Error("The host book holds 16 Macs.");
    secureWrite(this.file, [...others, parsed.data]);
    return parsed.data;
  }
  remove(name: string) {
    const hosts = this.list();
    const kept = hosts.filter((host) => host.name !== name);
    if (kept.length === hosts.length) return false;
    secureWrite(this.file, kept);
    return true;
  }
}

/** One argument for a shell: single quotes, and '\'' for a quote inside it. */
export const shellQuote = (value: string) =>
  `'${value.replaceAll("\0", "").replaceAll("'", `'\\''`)}'`;

/**
 * The line that the remote Mac's shell gets. A login zsh runs the command, so
 * the PATH of a person's own terminal applies there (Homebrew, ~/.local/bin).
 * Every word is quoted once for that zsh, and the whole line once more for the
 * shell that ssh starts.
 */
export const remoteLine = (words: string[]) =>
  `/bin/zsh -lc ${shellQuote(words.map(shellQuote).join(" "))}`;

const sshBinary = "/usr/bin/ssh";
/** Every call to a remote Mac is this argument list. No local shell is used. */
export const sshArguments = (host: RemoteHost, words: string[]) => [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=5",
  "--",
  host.ssh,
  remoteLine([host.command, ...words]),
];
export const remoteCall = (
  host: RemoteHost,
  words: string[],
  run: Runner,
  timeoutMs = 6000,
) => run(sshBinary, sshArguments(host, words), timeoutMs);

/** Why a call failed, in words for the person. */
export function remoteFailure(host: RemoteHost, status: number | null) {
  if (status === null) return "No answer in time.";
  if (status === 255)
    return `ssh could not connect. It must work with no password prompt: ssh ${host.ssh} true`;
  if (status === 127)
    return "The clawdtime command was not found there. Add the Mac again with --command /full/path/to/clawdtime.";
  return `ClawdTime on that Mac ended with status ${status}. Both Macs need the same ClawdTime version.`;
}

export const mergedId = (host: string, id: string) => `${host}_${id}`;
/** The id that the remote Mac itself uses for this session. */
export const remoteId = (session: Pick<AgentSession, "id" | "host">) =>
  session.host ? session.id.slice(session.host.length + 1) : session.id;

/** The board of one remote Mac, with ids that are unique on this Mac. */
export async function remoteBoard(
  host: RemoteHost,
  run: Runner,
  timeoutMs = 6000,
): Promise<
  { ok: true; sessions: AgentSession[] } | { ok: false; message: string }
> {
  // --local: that Mac lists its own sessions only, and asks no Mac in its own book.
  const result = await remoteCall(
    host,
    ["agents", "--json", "--local"],
    run,
    timeoutMs,
  );
  if (result.status !== 0)
    return { ok: false, message: remoteFailure(host, result.status) };
  let parsed: BoardSnapshot;
  try {
    parsed = boardSnapshotSchema.parse(JSON.parse(result.stdout));
  } catch {
    return {
      ok: false,
      message:
        "Its answer was not a board. Both Macs need the same ClawdTime version.",
    };
  }
  const sessions: AgentSession[] = [];
  for (const session of parsed.sessions) {
    const id = mergedId(host.name, session.id);
    if (session.host || id.length > 64) continue;
    const parent = session.spawnedBy
      ? mergedId(host.name, session.spawnedBy)
      : null;
    sessions.push({
      ...session,
      id,
      host: host.name,
      spawnedBy: parent && parent.length <= 64 ? parent : null,
      // From here a click opens its tmux pane, or only a shell on that Mac.
      focus:
        session.mode !== "interactive"
          ? "none"
          : session.terminal.tmux
            ? "pane"
            : "app",
    });
  }
  return { ok: true, sessions };
}

interface Asked<T> {
  inFlight: boolean;
  askedAt: number;
  good: { at: number; value: T } | null;
  failure: string | null;
  checkedAt: number | null;
}
interface PollOptions {
  book: HostBook;
  run: Runner;
  now: () => number;
  /** The least time between two calls to one host. */
  everyMs?: number;
  timeoutMs?: number;
  /** A good answer older than this is not used. */
  staleMs?: number;
}
type Answer<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Asks each host on its own rhythm and keeps its last good answer. At most one
 * call is in flight for a host, and a host that fails or hangs delays nothing.
 */
class Polled<T> {
  private readonly hosts = new Map<string, Asked<T>>();
  constructor(
    protected readonly book: HostBook,
    protected readonly now: () => number,
    private readonly everyMs: number,
    private readonly staleMs: number,
    private readonly ask: (host: RemoteHost) => Promise<Answer<T>>,
  ) {}
  /**
   * Starts a call for each host that is due, or for the one host named. It
   * never waits for a host; the promise is for callers that want the answers.
   */
  poll(only?: string): Promise<void> {
    const listed = this.book.list();
    for (const name of [...this.hosts.keys()])
      if (!listed.some((host) => host.name === name)) this.hosts.delete(name);
    const started: Promise<void>[] = [];
    for (const host of listed) {
      if (only !== undefined && host.name !== only) continue;
      let state = this.hosts.get(host.name);
      if (!state) {
        state = {
          inFlight: false,
          askedAt: Number.NEGATIVE_INFINITY,
          good: null,
          failure: null,
          checkedAt: null,
        };
        this.hosts.set(host.name, state);
      }
      if (state.inFlight || this.now() - state.askedAt < this.everyMs) continue;
      const asked = state;
      asked.inFlight = true;
      asked.askedAt = this.now();
      started.push(
        this.ask(host)
          .catch((): Answer<T> => ({ ok: false, message: "No answer." }))
          .then((result) => {
            asked.inFlight = false;
            asked.checkedAt = this.now();
            if (result.ok) {
              asked.good = { at: this.now(), value: result.value };
              asked.failure = null;
            } else asked.failure = result.message;
          }),
      );
    }
    return Promise.all(started).then(() => undefined);
  }
  /** Each host with its answer, when that answer is not too old. */
  protected answers() {
    return [...this.hosts].map(([name, state]) => ({
      name,
      state,
      value:
        state.good && this.now() - state.good.at <= this.staleMs
          ? state.good.value
          : null,
    }));
  }
  protected change(name: string, next: (value: T) => T) {
    const state = this.hosts.get(name);
    if (state?.good) state.good.value = next(state.good.value);
  }
}

/** The boards of the remote Macs, merged into the board of this Mac. */
export class RemoteBoards extends Polled<AgentSession[]> {
  constructor(options: PollOptions) {
    super(
      options.book,
      options.now,
      options.everyMs ?? 9000,
      options.staleMs ?? 30_000,
      async (host) => {
        const board = await remoteBoard(
          host,
          options.run,
          options.timeoutMs ?? 6000,
        );
        return board.ok ? { ok: true, value: board.sessions } : board;
      },
    );
  }
  /** This Mac's snapshot plus the last good answer of each host. */
  merge(snapshot: BoardSnapshot): BoardSnapshot {
    const hosts = this.answers();
    if (!hosts.length) return snapshot;
    const sessions = [
      ...snapshot.sessions,
      ...hosts.flatMap((host) => host.value ?? []),
    ]
      .sort(order)
      .slice(0, 500);
    const statuses: HostStatus[] = hosts.map(({ name, state, value }) => ({
      name,
      ok: value !== null && state.failure === null,
      sessions: value?.length ?? 0,
      checkedAt: state.checkedAt,
      message: (
        state.failure ??
        (value !== null
          ? ""
          : state.checkedAt === null
            ? "Not asked yet."
            : "No answer for some time.")
      ).slice(0, 200),
    }));
    return {
      ...snapshot,
      counts: countStates(sessions),
      sessions,
      hosts: statuses,
    };
  }
}

/**
 * This Mac's board plus each remote Mac's, asked once: for the one-shot
 * commands. With `only`, the board of that one remote Mac.
 */
export async function boardWithRemotes(
  local: BoardSnapshot,
  book: HostBook,
  run: Runner,
  now: () => number,
  only?: string,
) {
  const remotes = new RemoteBoards({ book, run, now });
  await remotes.poll(only);
  return remotes.merge(
    only === undefined
      ? local
      : { ...local, sessions: [], counts: countStates([]) },
  );
}

export type RemoteRequest = DecisionRequest & { host: string };
const pendingSchema = z
  .object({ pending: z.array(requestSchema).max(200) })
  .passthrough();

/**
 * What the agents on the remote Macs ask. Each read there also tells that
 * Mac's hooks that someone attends, so they hold for an answer from here.
 */
export class RemoteDesk extends Polled<DecisionRequest[]> {
  private readonly run: Runner;
  constructor(options: PollOptions) {
    super(
      options.book,
      options.now,
      options.everyMs ?? 4000,
      options.staleMs ?? 12_000,
      async (host) => {
        const result = await remoteCall(
          host,
          ["agents", "pending", "--json", "--attend"],
          options.run,
          options.timeoutMs ?? 6000,
        );
        if (result.status !== 0)
          return { ok: false, message: remoteFailure(host, result.status) };
        try {
          const { pending } = pendingSchema.parse(JSON.parse(result.stdout));
          return { ok: true, value: pending };
        } catch {
          return { ok: false, message: "Its answer was not a list." };
        }
      },
    );
    this.run = options.run;
  }
  pending(): RemoteRequest[] {
    const now = this.now();
    return this.answers().flatMap((host) =>
      (host.value ?? [])
        .filter((request) => request.holdUntil >= now)
        .map((request) => ({ ...request, host: host.name })),
    );
  }
  /** Hands the person's answer to ClawdTime on the Mac that asked. */
  async answer(input: {
    id: string;
    decision: "allow" | "deny" | "answer";
    text?: string | null;
    remember?: boolean;
  }): Promise<boolean> {
    const request = this.pending().find((item) => item.id === input.id);
    const host = this.book.get(request?.host);
    if (!request || !host) return false;
    const text = (input.text ?? "")
      .replace(/\p{C}/gu, " ")
      .trim()
      .slice(0, 600);
    if (input.decision === "answer" && !text) return false;
    const words =
      input.decision === "allow"
        ? ["approve", request.id, ...(input.remember ? ["--always"] : [])]
        : input.decision === "deny"
          ? ["deny", request.id, ...(text ? ["--message", text] : [])]
          : ["answer", request.id, "--", text];
    const result = await remoteCall(
      host,
      ["agents", ...words],
      this.run,
      10_000,
    );
    if (result.status !== 0) return false;
    // It is answered: it leaves this Mac's list at once, before the next read.
    this.change(host.name, (pending) =>
      pending.filter((item) => item.id !== request.id),
    );
    return true;
  }
}

/** Types the person's words into a session on a remote Mac, through ClawdTime there. */
export async function remoteSend(
  host: RemoteHost,
  session: AgentSession,
  value: string,
  enter: boolean,
  run: Runner,
): Promise<{ ok: boolean; route: "remote" | "none" }> {
  const text = cleanInput(value);
  if (!text.trim()) return { ok: false, route: "none" };
  const result = await remoteCall(
    host,
    [
      "agents",
      "send",
      remoteId(session),
      ...(enter ? [] : ["--no-enter"]),
      "--",
      text,
    ],
    run,
    10_000,
  );
  return { ok: result.status === 0, route: "remote" };
}

/**
 * The script that opens a session of a remote Mac in a new terminal window on
 * this Mac. In tmux it attaches to the session's own pane. Outside tmux a
 * running program cannot be attached to, so it opens a shell on that Mac.
 */
export function remoteWindowScript(host: RemoteHost, session: AgentSession) {
  const tmux = session.terminal.tmux;
  const words = [sshBinary, "-t", "--", host.ssh];
  if (tmux) {
    const pane = ["-t", tmux.paneId];
    words.push(
      remoteLine([
        "tmux",
        ...tmux.socketArgs,
        "attach-session",
        ...pane,
        ";",
        "select-window",
        ...pane,
        ";",
        "select-pane",
        ...pane,
      ]),
    );
  }
  return {
    pane: tmux !== null,
    text: `#!/bin/sh\n# Written by ClawdTime on every use. It opens one session of the Mac "${host.name}".\nexec ${words.map(shellQuote).join(" ")}\n`,
  };
}

export type RemoteFocus = "remote_pane" | "remote_mac" | "none";
/** Opens that window. It sends nothing to the session. */
export async function focusRemote(
  host: RemoteHost,
  session: AgentSession,
  run: Runner,
  root: string,
): Promise<{ ok: boolean; precision: RemoteFocus }> {
  if (session.focus === "none") return { ok: false, precision: "none" };
  const script = remoteWindowScript(host, session);
  const directory = join(root, "agents", "remote");
  const file = join(directory, `${host.name}.command`);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (existsSync(file) && !lstatSync(file).isFile())
      return { ok: false, precision: "none" };
    writeFileSync(file, script.text, { mode: 0o700 });
    chmodSync(file, 0o700);
  } catch {
    return { ok: false, precision: "none" };
  }
  // macOS opens a .command file in a new window of the terminal application.
  const opened = await run("/usr/bin/open", [file], 5000);
  if (opened.status !== 0) return { ok: false, precision: "none" };
  return { ok: true, precision: script.pane ? "remote_pane" : "remote_mac" };
}
