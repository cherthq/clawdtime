/**
 * `clawdtime recordings`: the recorded calls of the line on this Mac. The
 * command reads the owner-only files of the line itself; it needs no service.
 * `admin` makes the token of the admin page of the desktop service.
 */
import { spawn } from "node:child_process";
import { closeSync, constants, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  desktopStateFolder,
  findDesktopService,
} from "../connectors/agents/desktop-chat.js";
import {
  ADMIN_BASE,
  adminTokenFile,
  makeAdminToken,
  readAdminToken,
} from "../src/recordings/admin.js";
import {
  plainDuration,
  Recordings,
  recordingsFolder,
  zipFiles,
  zipList,
  type CallSummary,
} from "../src/recordings/store.js";

export const recordingsHelp = `clawdtime recordings: the recorded calls of the line on this Mac
  recordings list [--json]              every call: time, line, duration and recorded parts
  recordings show CALL [--json]         one call: its times, its parts and its transcript
  recordings export CALL [--to FILE]    write one call as a zip file (default: clawdtime-call-CALL.zip here)
  recordings delete CALL [--yes]        remove one call and all its files. It asks first
  recordings admin [--new] [--open]     make the token of the admin page and show its address.
                                        --new makes a new token. --open opens the page
Add --dir FOLDER to read another recordings folder.
Recording is off on each line until its .env.local says CLAWDTIME_LINE_RECORDING=on.
Each call is removed after its retention date. See docs/RECORDING.md.`;

export interface RecordingsCliDependencies {
  env?: Record<string, string | undefined>;
  home?: string;
  cwd?: string;
  now?: () => number;
  print?: (line: string) => void;
  /** Asks one question and gives the answer. Null when no one can answer (no terminal). */
  ask?: (question: string) => Promise<string | null>;
  /** Opens a web address in the browser. */
  openUrl?: (url: string) => void;
}

async function askTerminal(question: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await terminal.question(question);
  } finally {
    terminal.close();
  }
}

const when = (iso: string | null) =>
  iso ? iso.replace("T", " ").replace(/\.[0-9]+Z$/, " UTC") : "not known";
const partNames: Record<string, string> = {
  transcript: "transcript",
  "caller-audio": "caller audio",
  "agent-audio": "agent audio",
  "mixed-audio": "both sides",
  video: "video",
};
const parts = (call: CallSummary) =>
  [...new Set(call.parts.map((part) => partNames[part.part]))].join(", ") ||
  "nothing";

function flags(args: string[], known: string[], valued: string[]) {
  const values: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (valued.includes(name)) {
      const value = args[++i];
      if (!value || value.startsWith("--"))
        throw new Error(`Give a value after --${name}.`);
      values[name] = value;
    } else if (known.includes(name)) values[name] = true;
    else
      throw new Error(
        `Unknown option --${name}. See: clawdtime recordings help`,
      );
  }
  return { values, rest };
}

export async function recordingsCli(
  args: string[],
  dependencies: RecordingsCliDependencies = {},
): Promise<number> {
  const env = dependencies.env ?? process.env;
  const home = dependencies.home ?? homedir();
  const print = dependencies.print ?? ((line: string) => console.log(line));
  const ask = dependencies.ask ?? askTerminal;
  const [command = "help", ...more] = args;
  if (["help", "--help", "-h"].includes(command)) {
    print(recordingsHelp);
    return 0;
  }
  let parsed;
  try {
    parsed = flags(more, ["json", "yes", "new", "open"], ["dir", "to"]);
  } catch (error) {
    print((error as Error).message);
    return 2;
  }
  const { values, rest } = parsed;
  const dir =
    typeof values.dir === "string"
      ? isAbsolute(values.dir)
        ? values.dir
        : resolve(dependencies.cwd ?? process.cwd(), values.dir)
      : recordingsFolder(env, home);
  if (!dir) {
    print(
      "CLAWDTIME_LINE_RECORDING_DIR must be an absolute path. Nothing was read.",
    );
    return 1;
  }
  const recordings = new Recordings(dir, {
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  const problem = recordings.problem();
  if (problem && command !== "admin") {
    print(problem);
    return 1;
  }
  const one = (): CallSummary | null => {
    const id = rest[0];
    if (!id) {
      print(`Give the call. See its name with: clawdtime recordings list`);
      return null;
    }
    const found = recordings.get(id);
    if (!found) print(`There is no call ${id} in ${dir}.`);
    return found?.call ?? null;
  };

  if (command === "list") {
    const calls = recordings.list();
    if (values.json) {
      print(JSON.stringify({ folder: dir, calls }));
      return 0;
    }
    if (!calls.length) {
      print(`No recorded calls in ${dir}.`);
      return 0;
    }
    for (const call of calls)
      print(
        `${call.id}  ${when(call.callStartedAt)}  ${call.line}  ${plainDuration(call.durationMs)}  ${parts(call)}${call.stoppedBy === "caller" ? "  (stopped by the caller)" : ""}${call.status === "incomplete" ? "  (not finished)" : ""}`,
      );
    return 0;
  }
  if (command === "show") {
    const call = one();
    if (!call) return 1;
    const { transcript } = recordings.get(call.id)!;
    if (values.json) {
      print(JSON.stringify({ call, transcript }));
      return 0;
    }
    print(`Call ${call.id} on the line ${call.line}`);
    print(`Started: ${when(call.callStartedAt)}`);
    print(`Ended: ${when(call.endedAt)}`);
    print(
      `Duration: ${plainDuration(call.durationMs)}. Recorded: ${plainDuration(call.recordedMs)}.`,
    );
    if (call.stoppedBy === "caller") print("The caller stopped the recording.");
    print(`Kept until: ${when(call.keepUntil)}`);
    for (const part of call.parts)
      print(
        `Part: ${partNames[part.part]}, ${part.file}, ${part.bytes ?? 0} bytes`,
      );
    for (const item of call.missing)
      print(`Not recorded: ${item.part}. ${item.reason}`);
    print("Transcript:");
    for (const turn of transcript) {
      const seconds = Math.floor(turn.offsetMs / 1000);
      print(
        `  ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}  ${turn.who === "caller" ? "Caller" : turn.who === "agent" ? "Agent" : "Note"}: ${turn.text}`,
      );
    }
    return 0;
  }
  if (command === "export") {
    const call = one();
    if (!call) return 1;
    const target = resolve(
      dependencies.cwd ?? process.cwd(),
      typeof values.to === "string"
        ? values.to
        : `clawdtime-call-${call.id}.zip`,
    );
    let fd: number;
    try {
      fd = openSync(
        target,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      print(
        `${target} is there already or cannot be made. Nothing was written.`,
      );
      return 1;
    }
    try {
      for await (const chunk of zipFiles(zipList(recordings, call.id)))
        writeSync(fd, chunk);
    } finally {
      closeSync(fd);
    }
    print(`Wrote ${target}. It holds personal data: keep it private.`);
    return 0;
  }
  if (command === "delete") {
    const call = one();
    if (!call) return 1;
    if (!values.yes) {
      const answer = await ask(
        `Delete the call ${call.id} (${when(call.callStartedAt)}, ${parts(call)})? You cannot get it back. Type yes to delete: `,
      );
      if (answer === null) {
        print(
          "No terminal to ask. Nothing was deleted. Add --yes to delete without a question.",
        );
        return 1;
      }
      if (answer.trim().toLowerCase() !== "yes") {
        print("Nothing was deleted.");
        return 1;
      }
    }
    if (!recordings.delete(call.id)) {
      print(`The call ${call.id} could not be deleted.`);
      return 1;
    }
    print(`Deleted the call ${call.id}.`);
    return 0;
  }
  if (command === "admin") {
    const folder = desktopStateFolder({ env, home });
    if (!folder) {
      print(
        "No desktop state folder. Set CLAWDTIME_DESKTOP_STATE to an absolute path.",
      );
      return 1;
    }
    const file = adminTokenFile(folder);
    try {
      if (values.new || !readAdminToken(file)) makeAdminToken(file);
    } catch (error) {
      print((error as Error).message);
      return 1;
    }
    const origin =
      findDesktopService(folder)?.origin ?? "http://127.0.0.1:3320";
    const address = `${origin}${ADMIN_BASE}`;
    print(`The admin page: ${address}`);
    print(
      `The admin token is in ${file}. It is for admins only. Do not share it.`,
    );
    print(
      values.new
        ? "This is a new token. The old token and its sessions do not work now."
        : "Run with --new to make a new token.",
    );
    if (!findDesktopService(folder))
      print(
        "The desktop service does not run now. Start it with: clawdtime start",
      );
    if (values.open) {
      const current = readAdminToken(file)!;
      // The token goes in the part of the address after #: the browser never sends it.
      (
        dependencies.openUrl ??
        ((url: string) =>
          spawn("open", [url], { stdio: "ignore", detached: true }).unref())
      )(`${address}#token=${current}`);
      print("The page opens in your browser.");
    }
    return 0;
  }
  print(`Unknown command ${command}. See: clawdtime recordings help`);
  return 2;
}
