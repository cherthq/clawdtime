import { describe, expect, it } from "vitest";
import { ProcessDesk } from "../connectors/system/act.js";
import { SystemProbes } from "../connectors/system/probes.js";
import {
  fakeHost,
  fakeNow,
  type FakeHost,
} from "./connectors-system-fixture.js";

const minute = 60_000;

function desk(options: { trust?: boolean; host?: FakeHost } = {}) {
  const host = options.host ?? fakeHost();
  let now = fakeNow;
  host.now = () => now;
  const processes = new ProcessDesk(new SystemProbes(host), {
    trust: options.trust ?? false,
  });
  return {
    host,
    processes,
    later: (ms: number) => (now += ms),
    act: (
      action: string,
      target: { pid?: unknown; name?: unknown },
      words: string,
      at = now,
      background = false,
    ) => processes.act({ action, ...target }, { words, at }, { background }),
  };
}

const quits = (host: FakeHost) =>
  host.calls.filter((call) => call.startsWith("/usr/bin/osascript"));
const opens = (host: FakeHost) =>
  host.calls.filter((call) => call.startsWith("/usr/bin/open"));

describe("a nice quit", () => {
  it("asks an app to quit at once, with no question and no signal", async () => {
    const { host, act } = desk();
    host.quitEnds.add(4242);
    expect(await act("quit", { name: "Stonepad" }, "quit Stonepad")).toBe(
      "Stonepad quit.",
    );
    expect(quits(host)).toHaveLength(1);
    expect(quits(host)[0]).toContain(
      "runningApplicationWithProcessIdentifier(4242)",
    );
    expect(host.signals).toEqual([]);
  });

  it("says when the app still runs after the quit, and does not force it", async () => {
    const { host, act } = desk();
    expect(await act("quit", { pid: 4242 }, "quit it")).toBe(
      "Asked Stonepad to quit. It still runs after 5 s: it may show a save sheet, or not respond. A force quit ends it, and what it did not save is lost.",
    );
    expect(host.signals).toEqual([]);
  });

  it("asks first before it stops a process that is no app", async () => {
    const { host, act, later } = desk();
    const asked = await act("quit", { name: "syncd" }, "stop syncd");
    expect(asked).toBe(
      'Not done yet: this needs the owner\'s yes. Ask them in these words: "Stop syncd (pid 7000)? It is no app, so it cannot save first. Changes that are not saved are lost. Say yes or no." When they say yes, call process_act again with the same action and target.',
    );
    expect(host.signals).toEqual([]);
    later(10_000);
    expect(await act("quit", { name: "syncd" }, "yes")).toBe(
      "Stopped syncd (pid 7000).",
    );
    expect(host.signals).toEqual([{ pid: 7000, signal: "SIGTERM" }]);
  });
});

describe("a force quit", () => {
  const question =
    "Force quit Stonepad (pid 4242)? Changes that are not saved are lost. Say yes or no.";

  it("asks first, then acts on the owner's own clear yes that came after the question", async () => {
    const { host, act, later } = desk();
    expect(
      await act("force_quit", { name: "Stonepad" }, "force quit Stonepad"),
    ).toContain(`Ask them in these words: "${question}"`);
    expect(host.signals).toEqual([]);
    later(20_000);
    expect(await act("force_quit", { name: "Stonepad" }, "yes")).toBe(
      "Force quit Stonepad (pid 4242). It no longer runs.",
    );
    expect(host.signals).toEqual([{ pid: 4242, signal: "SIGKILL" }]);
  });

  it("takes no yes that came before its question, and no yes that is not clear", async () => {
    const { host, act, later } = desk();
    const before = fakeNow - 1000;
    await act("force_quit", { pid: 4242 }, "yes", before);
    // The same words, from before the question: no answer to it.
    expect(await act("force_quit", { pid: 4242 }, "yes", before)).toBe(
      `Waiting for the owner's clear yes or no to: "${question}"`,
    );
    later(5000);
    for (const words of ["ok", "sure", "yes, but first save it", "hmm"])
      expect(await act("force_quit", { pid: 4242 }, words)).toBe(
        `Waiting for the owner's clear yes or no to: "${question}"`,
      );
    expect(host.signals).toEqual([]);
  });

  it("does nothing on a no, and a later yes needs a new question", async () => {
    const { host, act, later } = desk();
    await act("force_quit", { pid: 4242 }, "force quit it");
    later(5000);
    expect(await act("force_quit", { pid: 4242 }, "no")).toBe(
      "The owner said no, so nothing was done.",
    );
    later(5000);
    expect(await act("force_quit", { pid: 4242 }, "yes")).toContain(
      "Not done yet: this needs the owner's yes.",
    );
    expect(host.signals).toEqual([]);
  });

  it("asks again when the question is older than five minutes", async () => {
    const { host, act, later } = desk();
    await act("force_quit", { pid: 4242 }, "force quit it");
    later(6 * minute);
    expect(await act("force_quit", { pid: 4242 }, "yes")).toContain(
      "Not done yet: this needs the owner's yes.",
    );
    expect(host.signals).toEqual([]);
  });

  it("acts at once when the owner's words ask to lose the changes", async () => {
    const { host, act } = desk();
    expect(
      await act(
        "force_quit",
        { name: "Stonepad" },
        "force quit Stonepad without saving",
      ),
    ).toBe("Force quit Stonepad (pid 4242). It no longer runs.");
    expect(host.signals).toEqual([{ pid: 4242, signal: "SIGKILL" }]);
  });

  it("acts at once with the owner's trust on, and says so", async () => {
    const { host, act } = desk({ trust: true });
    expect(await act("force_quit", { name: "Stonepad" }, "kill Stonepad")).toBe(
      "Force quit Stonepad (pid 4242). It no longer runs. The owner's trust is on, so no question was asked.",
    );
    expect(host.signals).toEqual([{ pid: 4242, signal: "SIGKILL" }]);
  });

  it("does nothing when the pid is another process by the time of the yes", async () => {
    const { host, act, later } = desk();
    await act("force_quit", { pid: 4242 }, "force quit it");
    host.outputs["/bin/ps -ww -o lstart=,command= -p 4242"] = {
      code: 0,
      stdout:
        "Thu Nov 26 09:59:58 2026     /Applications/Stonepad.app/Contents/MacOS/Stonepad\n",
      timedOut: false,
      cut: false,
      missing: false,
    };
    later(5000);
    expect(await act("force_quit", { pid: 4242 }, "yes")).toContain(
      "Not done yet: this needs the owner's yes.",
    );
    expect(host.signals).toEqual([]);
  });
});

describe("what is never touched", () => {
  it("refuses launchd, the kernel, WindowServer, loginwindow and ClawdTime itself, with trust on too", async () => {
    const { host, act } = desk({ trust: true });
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ pid: 1 }, /launchd is a part of macOS that keeps the Mac running/],
      [{ name: "kernel_task" }, /kernel_task is a part of macOS/],
      [{ name: "WindowServer" }, /WindowServer is a part of macOS/],
      [{ name: "loginwindow" }, /loginwindow \(app\) is a part of macOS/],
      [{ pid: 8800 }, /node is a part of ClawdTime/],
      [{ pid: 8700 }, /ClawdTime runs inside node/],
      [{ name: "Terminal" }, /ClawdTime runs inside Terminal \(app\)/],
      [{ pid: 8810 }, /Chromium \(app\) is a part of ClawdTime/],
      [{ name: "ClawdTimeTaskPanel" }, /ClawdTime/],
    ];
    for (const [target, reason] of cases)
      for (const action of ["quit", "force_quit", "restart"]) {
        const said = await act(action, target, "force quit it, yes");
        expect(said, `${action} ${JSON.stringify(target)}`).toMatch(reason);
      }
    expect(host.signals).toEqual([]);
    expect(quits(host)).toEqual([]);
    expect(opens(host)).toEqual([]);
  });

  it("refuses a process of another user", async () => {
    const { host, act } = desk({ trust: true });
    expect(await act("force_quit", { pid: 7100 }, "kill backupd")).toBe(
      "backupd runs as another user (root), so ClawdTime cannot end it.",
    );
    expect(host.signals).toEqual([]);
  });

  it("refuses a pid, a name or an action that does not parse, and runs nothing", async () => {
    const { host, act } = desk({ trust: true });
    expect(await act("force_quit", { pid: "4242; rm -rf ~" }, "yes")).toMatch(
      /^Not done: the pid does not parse/,
    );
    expect(await act("force_quit", { name: 'Stonepad"; kill' }, "yes")).toMatch(
      /^Not done: the name does not parse/,
    );
    expect(await act("delete", { name: "Stonepad" }, "yes")).toBe(
      "Not done: the action must be quit, force_quit or restart.",
    );
    expect(await act("quit", {}, "yes")).toBe(
      "Not done: say which process, by its name or its pid.",
    );
    expect(host.calls).toEqual([]);
  });

  it("asks which one when a name fits more than one process", async () => {
    const { host, act } = desk({ trust: true });
    expect(await act("force_quit", { name: "node" }, "kill node")).toBe(
      "Not done: more than one process fits: node pid 5150; node pid 8700; node pid 8800. Say which one by its pid.",
    );
    expect(host.signals).toEqual([]);
  });
});

describe("a restart", () => {
  it("quits the app nicely, waits for it to end, and opens it again", async () => {
    const { host, act } = desk();
    host.quitEnds.add(4242);
    expect(await act("restart", { name: "Stonepad" }, "restart Stonepad")).toBe(
      "Restarted Stonepad: it quit, and it is opening again.",
    );
    expect(opens(host)).toEqual([
      "/usr/bin/open -a /Applications/Stonepad.app",
    ]);
    expect(host.signals).toEqual([]);
  });

  it("opens it behind the window in front while a computer task runs", async () => {
    const { host, act } = desk();
    host.quitEnds.add(4242);
    await act("restart", { pid: 4242 }, "restart it", fakeNow, true);
    expect(opens(host)).toEqual([
      "/usr/bin/open -g -a /Applications/Stonepad.app",
    ]);
  });

  it("does not start it again when it does not quit, and says what a force quit would cost", async () => {
    const { host, act } = desk();
    expect(await act("restart", { name: "Stonepad" }, "restart Stonepad")).toBe(
      "Stonepad did not quit in 8 s: it may show a save sheet, or not respond (98 percent CPU). It was not started again. A force quit ends it, and what it did not save is lost.",
    );
    expect(opens(host)).toEqual([]);
    expect(host.signals).toEqual([]);
  });

  it("opens an app that does not run, by its name", async () => {
    const { host, act } = desk();
    expect(await act("restart", { name: "Inkwell" }, "restart Inkwell")).toBe(
      "Inkwell did not run, so it is opening now.",
    );
    expect(opens(host)).toEqual(["/usr/bin/open -a Inkwell"]);
  });

  it("restarts only an app", async () => {
    const { host, act } = desk({ trust: true });
    expect(await act("restart", { name: "syncd" }, "restart syncd")).toBe(
      "Not done: only an app restarts here, and syncd is no app. Quit it, and what started it may start it again.",
    );
    expect(host.signals).toEqual([]);
  });
});
