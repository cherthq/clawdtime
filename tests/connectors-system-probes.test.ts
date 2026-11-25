import { describe, expect, it } from "vitest";
import { systemLook } from "../connectors/system/look.js";
import { parseElapsed, parseLog, parsePs } from "../connectors/system/parse.js";
import { SystemProbes } from "../connectors/system/probes.js";
import {
  hiddenArguments,
  parseLabel,
  parseName,
  parsePid,
  parsePort,
  redactArguments,
  redactLine,
} from "../connectors/system/words.js";
import { fakeHome, fakeHost, fixture } from "./connectors-system-fixture.js";

const look = async (args: Record<string, unknown>, host = fakeHost()) => ({
  host,
  text: await systemLook(new SystemProbes(host), args),
});

describe("what goes into a probe", () => {
  it("takes a pid, a name, a port and a label only when they parse", () => {
    expect(parsePid(4242)).toBe(4242);
    expect(parsePid("4242")).toBe(4242);
    for (const bad of [0, -1, 1.5, "42; rm", "0x10", "", null, "4242 4243"])
      expect(parsePid(bad)).toBeNull();
    expect(parseName("Stonepad")).toBe("Stonepad");
    expect(parseName("Stonepad.app")).toBe("Stonepad");
    expect(parseName("Stonepad Helper (Renderer)")).toBe(
      "Stonepad Helper (Renderer)",
    );
    for (const bad of [
      'Stonepad" || process == "x',
      "Stone\\pad",
      "*",
      "$(whoami)",
      "-rf",
      "",
      "a".repeat(80),
    ])
      expect(parseName(bad)).toBeNull();
    expect(parsePort(4173)).toBe(4173);
    expect(parsePort(":3000")).toBe(3000);
    for (const bad of [0, 70000, "30 00", "http"])
      expect(parsePort(bad)).toBeNull();
    expect(parseLabel("com.example.syncd")).toBe("com.example.syncd");
    expect(parseLabel("com.example;rm")).toBeNull();
  });

  it("refuses a look whose name, pid or port does not parse, and runs nothing for it", async () => {
    for (const args of [
      { what: "logs", name: 'Stonepad" OR 1==1' },
      { what: "process", pid: "4242; kill" },
      { what: "ports", port: "all" },
      { what: "processes", name: "$(id)" },
      { what: "disk" },
    ]) {
      const { host, text } = await look(args);
      expect(text).toMatch(/^Not read/);
      expect(host.calls).toEqual([]);
    }
  });
});

describe("what comes out of a probe", () => {
  it("hides arguments that look like a credential and writes the home folder as ~", () => {
    expect(
      redactArguments(
        "--password=hunter22x --api-key fake0value0123 --dir /Users/sam/Sync",
        fakeHome,
      ),
    ).toBe("--password [hidden] --api-key [hidden] --dir ~/Sync");
    expect(
      redactArguments("--db postgres://app:hunter22@db.example/x", fakeHome),
    ).toBe("--db [hidden]");
    expect(redactArguments("build --watch --port 4173", fakeHome)).toBe(
      "build --watch --port 4173",
    );
    expect(redactArguments("Bearer fakefakefakefake0123", fakeHome)).toBe(
      hiddenArguments,
    );
    expect(redactLine("Retrying with password=hunter22x", fakeHome)).toMatch(
      /^\[hidden/,
    );
    expect(redactLine("Saved /Users/sam/notes.db", fakeHome)).toBe(
      "Saved ~/notes.db",
    );
    // An address with leading zeros is no card number.
    expect(
      redactLine("KERN_INVALID_ADDRESS at 0x0000000000000010", fakeHome),
    ).toBe("KERN_INVALID_ADDRESS at 0x10");
  });
});

describe("the parsers", () => {
  it("reads every row of ps, its app and its time", () => {
    const rows = parsePs(fixture("ps-fields.txt"));
    expect(rows).toHaveLength(19);
    const stonepad = rows.find((row) => row.pid === 4242)!;
    expect(stonepad).toMatchObject({
      ppid: 1,
      uid: 501,
      cpu: 98.4,
      rssKb: 1_258_291,
      elapsed: 2 * 3600 + 3 * 60 + 11,
      state: "R",
      name: "Stonepad",
      app: "Stonepad",
      appPath: "/Applications/Stonepad.app",
      isApp: true,
    });
    expect(rows.find((row) => row.pid === 4250)).toMatchObject({
      name: "Stonepad Helper",
      app: "Stonepad",
      isApp: false,
    });
    expect(rows.find((row) => row.pid === 5160)).toMatchObject({
      name: "esbuild",
      state: "Z",
    });
    expect(rows.find((row) => row.pid === 0)?.name).toBe("kernel_task");
    expect(parseElapsed("22-06:03:16")).toBe(22 * 86_400 + 6 * 3600 + 196);
    expect(parseElapsed("05:12")).toBe(312);
    expect(parseElapsed("later")).toBeNull();
  });

  it("joins a log line that goes on to the one before it", () => {
    const lines = parseLog(fixture("log-show.txt"));
    expect(lines).toHaveLength(6);
    expect(lines.map((line) => line.level)).toEqual([
      "Df",
      "I",
      "E",
      "Df",
      "F",
      "Df",
    ]);
    expect(lines[4]!.text).toContain("Database is locked by another writer");
  });
});

describe("processes", () => {
  it("lists the top processes by CPU with a hint for an app that may not respond", async () => {
    const { text } = await look({ what: "processes" });
    const lines = text.split("\n");
    expect(lines[0]).toBe(
      "19 processes run, using 123 percent CPU in all (100 is one core). By CPU:",
    );
    expect(lines[1]).toBe(
      "Stonepad (app): pid 4242, 98 percent CPU, 1.2 GB, for 2 h 3 min, running. It may not be responding: it is at full CPU, busy or stuck in a loop.",
    );
    expect(lines[2]).toBe(
      "node: pid 5150, parent 5100, 13 percent CPU, 300 MB, for 5 min, sleeping.",
    );
    expect(lines).toHaveLength(9);
    expect(text).toContain("user _windowserver");
    // No argument and no path goes into a listing.
    expect(text).not.toMatch(/hunter|fake0value|\/Users|--watch/);
  });

  it("sorts by memory, and says why a stopped or stuck process may not answer", async () => {
    const { text } = await look({
      what: "processes",
      sort: "memory",
      limit: 20,
    });
    expect(text.split("\n")[1]).toMatch(/^Stonepad \(app\): pid 4242/);
    expect(text).toContain(
      "syncd: pid 7000, 0 percent CPU, 60 MB, for 10 min, stopped. It is stopped and does nothing until it gets a signal to go on.",
    );
    expect(text).toContain(
      "Ledgerly (app): pid 9100, 0 percent CPU, 80 MB, for 20 s, waiting on the system. It may not be responding: it is stuck in a call to the system.",
    );
    expect(text).toContain(
      "esbuild: pid 5160, parent 5150, 0 percent CPU, 1 KB, for 5 min, ended, a zombie. It ended, and its parent did not collect it.",
    );
  });

  it("finds processes by a word of their name or of their arguments, and never shows the arguments", async () => {
    const { text } = await look({ what: "processes", name: "build" });
    expect(text.split("\n")).toEqual([
      'Processes that match "build", by CPU:',
      "node: pid 5150, parent 5100, 13 percent CPU, 300 MB, for 5 min, sleeping. The words are in its arguments.",
      "esbuild: pid 5160, parent 5150, 0 percent CPU, 1 KB, for 5 min, ended, a zombie. It ended, and its parent did not collect it.",
    ]);
    // A credential in the arguments is no match: it is hidden before the search.
    expect((await look({ what: "processes", name: "hunter22x" })).text).toMatch(
      /^No process matches "hunter22x"/,
    );
  });
});

describe("one process", () => {
  it("shows the path, arguments, start, threads, files, ports and newest report", async () => {
    const { text } = await look({ what: "process", name: "Stonepad" });
    expect(text.split("\n")).toEqual([
      "Stonepad (app): pid 4242, parent launchd (1), 98 percent CPU, 1.2 GB (6.3 percent of memory), running.",
      "It may not be responding: it is at full CPU, busy or stuck in a loop.",
      "Path: /Applications/Stonepad.app/Contents/MacOS/Stonepad",
      "Arguments: -NSDocumentRevisionsDebugMode YES",
      "Started Thu Nov 26 08:00:12 2026, 2 h 3 min ago. 4 threads. 9 open files.",
      "Network: 127.0.0.1:4180 (TCP, LISTEN); 192.168.1.20:52144->203.0.113.9:443 (TCP, ESTABLISHED); *:5353 (UDP).",
      "Newest report of the last day: Stonepad hung 15 min ago, for 5.21s.",
    ]);
  });

  it("hides a credential in the arguments of one process", async () => {
    const host = fakeHost({
      outputs: {
        "/bin/ps -ww -o lstart=,command= -p 7000": {
          code: 0,
          stdout:
            "Thu Nov 26 09:50:00 2026     /usr/local/bin/syncd --password=hunter22x --api-key fake0value0123 --dir /Users/sam/Sync\n",
          timedOut: false,
          cut: false,
          missing: false,
        },
      },
    });
    const { text } = await look({ what: "process", pid: 7000 }, host);
    expect(text).toContain(
      "Arguments: --password [hidden] --api-key [hidden] --dir ~/Sync",
    );
    expect(text).not.toMatch(/hunter22x|fake0value0123|\/Users\/sam/);
  });

  it("asks which one when a name fits more than one process", async () => {
    const { text } = await look({ what: "process", name: "node" });
    expect(text).toBe(
      "More than one process fits: node pid 5150; node pid 8700; node pid 8800. Ask for one by its pid.",
    );
  });

  it("says so when no process has the pid or the name", async () => {
    expect((await look({ what: "process", pid: 31337 })).text).toBe(
      "No process has pid 31337 now.",
    );
    expect((await look({ what: "process", name: "Inkwell" })).text).toBe(
      "No process named Inkwell runs now.",
    );
  });
});

describe("ports", () => {
  it("lists what listens, by process", async () => {
    const { text } = await look({ what: "ports" });
    expect(text.split("\n")).toEqual([
      "The TCP ports that processes of this user listen on:",
      "node (pid 5150): listens on *:4173, 127.0.0.1:24678, [::1]:4173.",
      "Riverchat (app, pid 6001): listens on 127.0.0.1:52110.",
    ]);
  });

  it("shows who listens on one port and who is connected to it", async () => {
    const { text, host } = await look({ what: "ports", port: 4173 });
    expect(host.calls[0]).toBe("/usr/sbin/lsof -nP -iTCP:4173 -F pcfnT");
    expect(text.split("\n")).toEqual([
      "TCP port 4173:",
      "node (pid 5150): listens on *:4173; connected 127.0.0.1:4173->127.0.0.1:61022.",
      "Riverchat (app, pid 6001): connected 127.0.0.1:61022->127.0.0.1:4173.",
    ]);
  });

  it("says what it cannot see when nothing uses the port", async () => {
    expect((await look({ what: "ports", port: "9999" })).text).toBe(
      "Nothing of this user uses TCP port 9999. A process of another user, such as root, is not seen here.",
    );
  });
});

describe("logs", () => {
  it("reads the newest lines of one process with the name quoted, and hides a credential", async () => {
    const { text, host } = await look({ what: "logs", name: "Stonepad" });
    expect(host.calls.at(-1)).toBe(
      '/usr/bin/log show --last 5m --style compact --predicate process == "Stonepad"',
    );
    expect(text.split("\n")).toEqual([
      "Stonepad wrote 6 log lines in the last 5 minutes: 1 error and 1 fault. The newest that matter, oldest first:",
      "10:01:58 [com.example.stonepad:sync] Sync started for 3 notes",
      "10:01:59 [com.example.stonepad:sync] Uploading note 2 of 3",
      "10:02:00 error: [com.example.stonepad:sync] Upload failed: the server did not answer (timeout after 30 s)",
      "10:02:00 [hidden: the line looked like it held a credential]",
      "10:02:01 fault: [com.example.stonepad:store] Database is locked by another writer at ~/Library/Containers/com.example.stonepad/notes.db",
      "10:02:02 [com.example.stonepad:ui] Main thread blocked for 4200 ms",
    ]);
  });

  it("reads the log of a pid by its executable's name", async () => {
    const { host } = await look({ what: "logs", pid: 4242 });
    expect(host.calls.at(-1)).toContain('process == "Stonepad"');
  });

  it("says when a process wrote nothing", async () => {
    expect((await look({ what: "logs", name: "Riverchat" })).text).toBe(
      "Riverchat wrote no log lines in the last 5 minutes. The log knows a process by the name of its executable.",
    );
  });
});

describe("crash and hang reports", () => {
  it("gives the newest reports first, with the exception and the first frames, and no file name", async () => {
    const { text } = await look({ what: "crashes" });
    expect(text.split("\n")).toEqual([
      "5 reports in the last 7 days. The newest first:",
      "Riverchat crashed 2 min ago: EXC_BAD_ACCESS (SIGSEGV), KERN_INVALID_ADDRESS at 0x10. First frames: objc_msgSend; -[RCMessageList reloadRows:]; a frame in Riverchat; -[NSApplication run].",
      "Stonepad hung 15 min ago, for 5.21s.",
      "Memory ran short 3 h ago, and macOS ended processes to free it. The largest process was Stonepad.",
      "backupd went over a limit of macOS 12 h ago: cpu usage, for 180.00s.",
      "Ledgerly crashed 5 d 22 h ago: EXC_CRASH (SIGABRT), Namespace SIGNAL, Code 6 Abort trap: 6. First frames: __pthread_kill; pthread_kill; abort; -[LGLedger import:].",
    ]);
    expect(text).not.toMatch(/fake0token|2026-11-26-0958|\.ips|\.hang/);
  });

  it("keeps to one name and to the days asked for", async () => {
    expect((await look({ what: "crashes", name: "Riverchat" })).text).toMatch(
      /^1 report of Riverchat in the last 7 days\. The newest first:\nRiverchat crashed 2 min ago/,
    );
    expect(
      (await look({ what: "crashes", name: "Ledgerly", days: 1 })).text,
    ).toBe("No crash, hang or resource report of Ledgerly in the last 1 day.");
  });
});

describe("launchd jobs", () => {
  it("finds jobs by a part of their label, with their last exit", async () => {
    const { text, host } = await look({ what: "services", name: "syncd" });
    expect(host.calls).toEqual(["/bin/launchctl list"]);
    expect(text.split("\n")).toEqual([
      'launchd jobs of this user that match "syncd":',
      "com.example.syncd: not running; it last ended with exit code 78.",
      "com.example.syncd.helper: running, pid 7000.",
    ]);
  });

  it("with no label lists the jobs that ended with an error, others before Apple's", async () => {
    const { text } = await look({ what: "services" });
    expect(text.split("\n")).toEqual([
      "7 launchd jobs of this user, 3 running.",
      "These are not running, and ended with an error:",
      "com.example.syncd: not running; it last ended with exit code 78.",
      "com.example.riverchat.updater: not running; it was ended by signal 9, a kill.",
      "com.apple.ReportCrash: not running; it last ended with exit code 1.",
    ]);
  });
});

describe("memory, swap and disk", () => {
  it("says the pressure, swap, load and disk, and what holds the most memory", async () => {
    const { text } = await look({ what: "memory" });
    expect(text.split("\n")).toEqual([
      "Memory: 16.0 GB in all, 23 percent free, pressure warning.",
      "Swap: 2.3 GB used of 4.0 GB.",
      "Load: 10.71, 8.94, 8.55 over 1, 5 and 15 minutes, on 10 cores.",
      "Disk: 44.6 GB free, 90 percent used.",
      "Memory is short: the Mac swaps, and apps slow down.",
      "The disk is almost full: macOS slows down when little space is free.",
      "More work waits than there are cores.",
      "Most memory: Stonepad (app) 1.2 GB, pid 4242; Riverchat (app) 430 MB, pid 6001; node 300 MB, pid 5150; WindowServer 207 MB, pid 152; node 200 MB, pid 8800.",
    ]);
  });
});

describe("the programs that run", () => {
  it("are fixed paths with short timeouts and capped output, and never ask for an environment", async () => {
    const host = fakeHost();
    for (const what of ["processes", "ports", "crashes", "services", "memory"])
      await systemLook(new SystemProbes(host), { what });
    await systemLook(new SystemProbes(host), { what: "process", pid: 4242 });
    await systemLook(new SystemProbes(host), {
      what: "logs",
      name: "Stonepad",
    });
    expect(host.calls.length).toBeGreaterThan(10);
    for (const call of host.calls) {
      expect(call).toMatch(/^\/(?:usr\/)?s?bin\//);
      // ps -E and ps e print the environment; launchctl print does too.
      expect(call).not.toMatch(
        /ps .*(?:-E\b|\beww?\b)|launchctl print|\benv\b/,
      );
    }
    for (const limit of host.limits) {
      expect(limit.timeoutMs).toBeLessThanOrEqual(20_000);
      expect(limit.maxBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    }
  });

  it("says plainly when a program is missing or does not answer", async () => {
    const missing = fakeHost();
    missing.exec = async () => ({
      code: null,
      stdout: "",
      timedOut: false,
      cut: false,
      missing: true,
    });
    expect((await look({ what: "processes" }, missing)).text).toBe(
      "ps is not on this Mac, so this cannot be read.",
    );
    const slow = fakeHost();
    slow.exec = async () => ({
      code: null,
      stdout: "",
      timedOut: true,
      cut: false,
      missing: false,
    });
    expect((await look({ what: "logs", name: "Stonepad" }, slow)).text).toBe(
      "log did not answer in time. Try again.",
    );
  });
});
