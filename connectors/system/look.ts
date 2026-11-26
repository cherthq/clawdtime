/**
 * One look at the process level, in words for the chat: the arguments of
 * `system_look` are read and checked here, the probe runs, and its result
 * becomes a few short lines. A look changes nothing on the Mac.
 */
import type { Job, Report, SocketRow } from "./parse.js";
import {
  ProbeFailed,
  stateWord,
  type LogLook,
  type MemoryLook,
  type PortOwner,
  type ProcessDetail,
  type ProcessView,
  type SystemProbes,
} from "./probes.js";
import {
  parseCount,
  parseLabel,
  parseName,
  parsePid,
  parsePort,
  withoutHome,
} from "./words.js";

export const lookKinds = [
  "processes",
  "process",
  "ports",
  "logs",
  "crashes",
  "services",
  "memory",
] as const;
export type LookKind = (typeof lookKinds)[number];

const gb = 1024 ** 3;
const mb = 1024 ** 2;
/** Bytes as a person says them: 1.2 GB, 300 MB, 40 KB. */
export const size = (bytes: number) =>
  bytes >= gb
    ? `${(bytes / gb).toFixed(1)} GB`
    : bytes >= mb
      ? `${Math.round(bytes / mb)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Seconds as a person says them: 40 s, 5 min, 2 h 3 min, 3 d 4 h. */
export function duration(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) {
    const minutes = Math.floor((s % 3600) / 60);
    return `${Math.floor(s / 3600)} h${minutes ? ` ${minutes} min` : ""}`;
  }
  const hours = Math.floor((s % 86_400) / 3600);
  return `${Math.floor(s / 86_400)} d${hours ? ` ${hours} h` : ""}`;
}

const ago = (now: number, at: number) => `${duration((now - at) / 1000)} ago`;

/** The name of a process as the owner knows it: the app, or the executable and its app. */
export const label = (row: ProcessView) =>
  row.isApp && row.app
    ? `${row.app} (app)`
    : row.app
      ? `${row.name} (in ${row.app})`
      : row.name;

const percent = (value: number) => `${Math.round(value)} percent`;

function processLine(row: ProcessView, uid: number, parent = true) {
  const facts = [
    `pid ${row.pid}`,
    parent && row.ppid > 1 ? `parent ${row.ppid}` : "",
    row.uid !== uid ? `user ${row.user}` : "",
    `${percent(row.cpu)} CPU`,
    size(row.rssKb * 1024),
    `for ${duration(row.elapsed)}`,
    stateWord(row.state),
  ].filter(Boolean);
  return [
    `${label(row)}: ${facts.join(", ")}.`,
    row.matchedIn === "arguments" ? "The words are in its arguments." : "",
    row.hint ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

const socketText = (socket: SocketRow) =>
  `${socket.address} (${[socket.protocol, socket.state].filter(Boolean).join(", ") || "socket"})`;

function detailText(
  detail: ProcessDetail,
  uid: number,
  home: string,
  now: number,
) {
  const { row } = detail;
  const listening = detail.sockets.slice(0, 8);
  return [
    `${label(row)}: pid ${row.pid}, parent ${detail.parent ? `${detail.parent} (${row.ppid})` : row.ppid}${row.uid !== uid ? `, user ${row.user}` : ""}, ${percent(row.cpu)} CPU, ${size(row.rssKb * 1024)} (${row.mem.toFixed(1)} percent of memory), ${stateWord(row.state)}.`,
    row.hint ?? "",
    `Path: ${withoutHome(row.path, home)}`,
    `Arguments: ${detail.arguments || "none"}`,
    `Started ${detail.started ?? "at a time ps did not say"}, ${duration(row.elapsed)} ago.${detail.threads !== null ? ` ${detail.threads} threads.` : ""}${detail.files !== null ? ` ${detail.files} open files.` : ""}`,
    listening.length
      ? `Network: ${listening.map(socketText).join("; ")}${detail.sockets.length > listening.length ? `; and ${detail.sockets.length - listening.length} more` : ""}.`
      : "Network: no open port.",
    detail.report
      ? `Newest report of the last day: ${reportText(detail.report, now)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function portsText(owners: PortOwner[], port: number | null) {
  if (!owners.length)
    return port === null
      ? "No process of this user listens on a TCP port. A process of another user, such as root, is not seen here."
      : `Nothing of this user uses TCP port ${port}. A process of another user, such as root, is not seen here.`;
  const lines = owners.slice(0, 12).map((owner) => {
    const who = `${owner.name} (${owner.isApp ? "app, " : ""}pid ${owner.pid})`;
    const listen = owner.sockets.filter((socket) => socket.state === "LISTEN");
    const other = owner.sockets.filter((socket) => socket.state !== "LISTEN");
    return `${who}: ${[
      listen.length
        ? `listens on ${listen.map((socket) => socket.address).join(", ")}`
        : "",
      other.length
        ? `connected ${other
            .slice(0, 6)
            .map((socket) => socket.address)
            .join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join("; ")}.`;
  });
  return [
    port === null
      ? "The TCP ports that processes of this user listen on:"
      : `TCP port ${port}:`,
    ...lines,
  ].join("\n");
}

const level = (value: string) =>
  value === "E" ? "error: " : value === "F" ? "fault: " : "";

function logsText(look: LogLook) {
  const window = `in the last ${look.minutes} minute${look.minutes === 1 ? "" : "s"}`;
  if (!look.total)
    return `${look.name} wrote no log lines ${window}. The log knows a process by the name of its executable.`;
  const counts = [
    look.errors ? `${look.errors} error${look.errors === 1 ? "" : "s"}` : "",
    look.faults ? `${look.faults} fault${look.faults === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return [
    `${look.name} wrote ${look.total} log line${look.total === 1 ? "" : "s"} ${window}${counts.length ? `: ${counts.join(" and ")}` : ", none of them an error"}. The newest that matter, oldest first:`,
    ...look.lines.map(
      (line) => `${line.time} ${level(line.level)}${line.text}`,
    ),
    look.cut
      ? "The log was longer than its cap, so only its newest lines were read, and the counts are of those. Ask for fewer minutes to see them all."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** One report as a sentence: what happened to which process, and when. */
export function reportText(report: Report, now: number) {
  const when = ago(now, report.at);
  switch (report.kind) {
    case "crash":
      return `${report.name} crashed ${when}${report.what ? `: ${report.what}` : ""}.${report.frames.length ? ` First frames: ${report.frames.join("; ")}.` : ""}`;
    case "hang":
      return `${report.name} hung ${when}${report.duration ? `, for ${report.duration}` : ""}.`;
    case "spin":
      return `${report.name} was slow to answer ${when}${report.duration ? `, for ${report.duration}` : ""}.`;
    case "resource":
      return `${report.name} went over a limit of macOS ${when}${report.what ? `: ${report.what}` : ""}${report.duration ? `, for ${report.duration}` : ""}.`;
    case "memory":
      return `Memory ran short ${when}, and macOS ended processes to free it.${report.frames[0] ? ` The largest process was ${report.frames[0]}.` : ""}`;
    default:
      return `${report.name} has a diagnostic report from ${when}.`;
  }
}

function crashesText(
  found: { total: number; items: Report[] },
  name: string | null,
  days: number,
  now: number,
) {
  const window = `in the last ${days} day${days === 1 ? "" : "s"}`;
  if (!found.items.length)
    return `No crash, hang or resource report${name ? ` of ${name}` : ""} ${window}.`;
  return [
    `${found.total} report${found.total === 1 ? "" : "s"}${name ? ` of ${name}` : ""} ${window}. The newest first:`,
    ...found.items.map((report) => reportText(report, now)),
  ].join("\n");
}

const signals: Record<number, string> = {
  6: "an abort",
  9: "a kill",
  11: "a crash on memory",
  15: "a request to stop",
};

function jobText(job: Job) {
  if (job.pid !== null) return `${job.label}: running, pid ${job.pid}.`;
  if (job.status === null || job.status === 0)
    return `${job.label}: not running; it last ended with no error.`;
  return job.status < 0
    ? `${job.label}: not running; it was ended by signal ${-job.status}${signals[-job.status] ? `, ${signals[-job.status]}` : ""}.`
    : `${job.label}: not running; it last ended with exit code ${job.status}.`;
}

function memoryText(look: MemoryLook) {
  const lines = [
    [
      look.total ? `Memory: ${size(look.total)} in all` : "Memory",
      look.freePercent !== null ? `${look.freePercent} percent free` : "",
      look.pressure ? `pressure ${look.pressure}` : "",
    ]
      .filter(Boolean)
      .join(", ") + ".",
    look.swap
      ? `Swap: ${size(look.swap.used)} used of ${size(look.swap.total)}.`
      : "",
    look.load
      ? `Load: ${look.load.map((value) => value.toFixed(2)).join(", ")} over 1, 5 and 15 minutes${look.cores ? `, on ${look.cores} cores` : ""}.`
      : "",
    look.disk
      ? `Disk: ${size(look.disk.free)} free, ${look.disk.usedPercent} percent used.`
      : "",
    look.pressure === "warning" || look.pressure === "critical"
      ? "Memory is short: the Mac swaps, and apps slow down."
      : "",
    look.disk && look.disk.usedPercent >= 90
      ? "The disk is almost full: macOS slows down when little space is free."
      : "",
    look.load && look.cores && look.load[0]! > look.cores
      ? "More work waits than there are cores."
      : "",
    look.top.length
      ? `Most memory: ${look.top.map((row) => `${label(row)} ${size(row.rssKb * 1024)}, pid ${row.pid}`).join("; ")}.`
      : "",
  ];
  return lines.filter(Boolean).join("\n");
}

const refused = (what: string) =>
  `Not read: ${what} does not parse. Give a plain name, a pid or a port number.`;

/**
 * Runs one look from the arguments of the chat tool and says the result in
 * words. A wrong argument is refused with a reason; nothing runs for it.
 */
export async function systemLook(
  probes: SystemProbes,
  args: Record<string, unknown>,
): Promise<string> {
  const what = args.what;
  if (typeof what !== "string" || !lookKinds.includes(what as LookKind))
    return `Not read: what must be one of ${lookKinds.join(", ")}.`;
  const host = probes.host;
  const hasName =
    args.name !== undefined && args.name !== null && args.name !== "";
  const name = hasName ? parseName(args.name) : null;
  if (hasName && !name && what !== "services") return refused("the name");
  const hasPid = args.pid !== undefined && args.pid !== null && args.pid !== "";
  const pid = hasPid ? parsePid(args.pid) : null;
  if (hasPid && !pid) return refused("the pid");
  try {
    switch (what as LookKind) {
      case "processes": {
        const limit = parseCount(args.limit, 8, 1, 20);
        if (limit === null) return refused("the limit");
        const sort = args.sort === "memory" ? "memory" : "cpu";
        const result = await probes.processes({ sort, name, limit });
        if (name && !result.rows.length)
          return `No process matches "${name}". Its executable may have another name: try another word, or look at the top processes.`;
        return [
          name
            ? `Processes that match "${name}", by ${sort === "memory" ? "memory" : "CPU"}:`
            : `${result.total} processes run, using ${percent(result.cpu)} CPU in all (100 is one core). By ${sort === "memory" ? "memory" : "CPU"}:`,
          ...result.rows.map((row) => processLine(row, host.uid)),
        ].join("\n");
      }
      case "process": {
        if (!pid && !name)
          return "Not read: say which process, by its name or its pid.";
        const found = await probes.find({ pid, name });
        if (found.kind === "none") return found.reason;
        if (found.kind === "many")
          return `More than one process fits: ${found.rows
            .slice(0, 8)
            .map((row) => `${label(row)} pid ${row.pid}`)
            .join("; ")}. Ask for one by its pid.`;
        return detailText(
          await probes.detail(found.row),
          host.uid,
          host.home,
          host.now(),
        );
      }
      case "ports": {
        const hasPort =
          args.port !== undefined && args.port !== null && args.port !== "";
        const port = hasPort ? parsePort(args.port) : null;
        if (hasPort && !port) return refused("the port");
        return portsText(await probes.ports(port), port);
      }
      case "logs": {
        if (!pid && !name)
          return "Not read: say whose log, by a process name or a pid.";
        const minutes = parseCount(args.minutes, 5, 1, 60);
        if (minutes === null) return refused("the minutes");
        // The log knows a process by its executable's name.
        let process = name;
        if (pid || name) {
          const found = await probes.find({ pid, name }).catch(() => null);
          if (found?.kind === "one") process = found.row.name;
          else if (pid)
            return found?.kind === "none" ? found.reason : refused("the pid");
        }
        const checked = parseName(process);
        if (!checked) return refused("the process name");
        return logsText(await probes.logs(checked, minutes));
      }
      case "crashes": {
        const days = parseCount(args.days, 7, 1, 30);
        if (days === null) return refused("the days");
        return crashesText(
          await probes.reports({ name, days, limit: 5 }),
          name,
          days,
          host.now(),
        );
      }
      case "services": {
        const raw = args.label ?? args.name;
        const hasLabel = raw !== undefined && raw !== null && raw !== "";
        const value = hasLabel ? parseLabel(raw) : null;
        if (hasLabel && !value) return refused("the label");
        const look = await probes.services(value);
        if (value)
          return look.jobs.length
            ? [
                `launchd jobs of this user that match "${value}":`,
                ...look.jobs.map(jobText),
              ].join("\n")
            : `No launchd job of this user matches "${value}".`;
        return [
          `${look.total} launchd jobs of this user, ${look.running} running.`,
          look.jobs.length
            ? "These are not running, and ended with an error:"
            : "None of the others ended with an error.",
          ...look.jobs.map(jobText),
        ].join("\n");
      }
      case "memory":
        return memoryText(await probes.memory());
    }
  } catch (error) {
    return error instanceof ProbeFailed
      ? error.message
      : "Reading that failed on this Mac. Nothing was changed.";
  }
  return "Not read.";
}
