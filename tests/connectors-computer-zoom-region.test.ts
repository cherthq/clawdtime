import { describe, expect, it } from "vitest";
import {
  LOOK_FRESH_MS,
  LastLook,
  resolveRegion,
  systemWindows,
  type ScreenWindow,
} from "../connectors/computer/zoom-region.js";
import { PanelHands } from "../connectors/computer/panel-hands.js";
import {
  computerPort,
  offComputerPort,
} from "../connectors/computer/service.js";
import type { ComputerWorker } from "../connectors/computer/worker.js";
import type { Observation } from "../connectors/computer/ports.js";
import { createTaskApp } from "../src/control/task-app.js";
import type { TaskService } from "../src/control/task-service.js";
import type { TaskDesktopService } from "../src/control/task-desktop-service.js";
import { DomainError } from "../src/storage/security.js";
import { phonePresentationSchema } from "../src/phone-desktop-contracts.js";
import { presentationFact } from "../connectors/agents/phone-turn.js";
import { requestRegion } from "../line/presentation-source.mjs";

// A synthetic look at a made-up app. Nothing here comes from a real screen.
const element = (
  id: number,
  role: string,
  title: string,
  x: number,
  y: number,
  w: number,
  h: number,
  more: Partial<Observation["elements"][number]> = {},
) => ({
  id,
  role,
  title,
  x,
  y,
  w,
  h,
  enabled: true,
  focused: false,
  secure: false,
  ...more,
});
const observation = (more: Partial<Observation> = {}): Observation => ({
  at: 1,
  surfaceEpoch: 3,
  screen: { width: 1440, height: 900, scale: 2 },
  cursor: { x: 0, y: 0 },
  app: {
    name: "Stonepad",
    bundleId: "test.stonepad",
    window: "Quarterly fixture",
  },
  elements: [
    element(0, "AXTextField", "Address and search bar", 288, 36, 720, 27, {
      value: "fixture.test/report",
    }),
    element(1, "AXStaticText", "Send a note to the team", 90, 630, 288, 18),
    element(2, "AXButton", "Send", 1296, 810, 72, 27),
    element(
      3,
      "AXStaticText",
      "Upload failed: the file is too large",
      432,
      450,
      432,
      18,
    ),
    element(4, "AXImage", "Revenue chart", 144, 135, 720, 270),
    element(5, "AXImage", "", 1200, 100, 100, 100),
    element(6, "AXTextField", "Passcode", 600, 700, 200, 24, {
      secure: true,
      value: "hidden-fixture-word",
    }),
  ],
  ...more,
});
const windows: ScreenWindow[] = [
  { owner: "Stonepad", x: 0, y: 0.03, w: 0.75, h: 0.95 },
  { owner: "Riverchat", x: 0.5, y: 0.1, w: 0.5, h: 0.8 },
  { owner: "Stonepad", x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
  { owner: "Ledger Notes", x: 0.2, y: 0.2, w: 0.4, h: 0.5 },
];
const share = (x: number, y: number, w: number, h: number) => ({
  x: Math.round((x / 1440) * 10000) / 10000,
  y: Math.round((y / 900) * 10000) / 10000,
  w: Math.round((w / 1440) * 10000) / 10000,
  h: Math.round((h / 900) * 10000) / 10000,
});

function fixture(list: ScreenWindow[] | null = windows) {
  let now = 50_000;
  const look = new LastLook(() => now);
  look.take(observation());
  let reads = 0;
  const deps = {
    look,
    windows: async () => {
      reads++;
      return list;
    },
  };
  return {
    look,
    reads: () => reads,
    advance: (ms: number) => {
      now += ms;
    },
    find: (name: string) => resolveRegion(name, deps),
  };
}

describe("call zoom region resolver", () => {
  it("finds things by their names, kinds and words from the last look", async () => {
    const f = fixture();
    expect(await f.find("the address bar")).toEqual({
      version: 1,
      code: "found",
      match: "element",
      region: share(288, 36, 720, 27),
    });
    expect((await f.find("the Send button")).region).toEqual(
      share(1296, 810, 72, 27),
    );
    // The exact name beats a text that only holds the word.
    expect((await f.find("Send")).region).toEqual(share(1296, 810, 72, 27));
    expect((await f.find("the text that says send a note")).region).toEqual(
      share(90, 630, 288, 18),
    );
    expect((await f.find("the error message")).region).toEqual(
      share(432, 450, 432, 18),
    );
    expect((await f.find("the chart")).region).toEqual(
      share(144, 135, 720, 270),
    );
    // Only a kind: the largest thing of that kind.
    expect((await f.find("the picture")).region).toEqual(
      share(144, 135, 720, 270),
    );
    expect((await f.find("the button")).region).toEqual(
      share(1296, 810, 72, 27),
    );
    // A kind that does not fit counts only with the exact name.
    expect((await f.find("the Upload button")).code).toBe("no_match");
    // A word for the same thing ranks below the word itself: the address
    // field wins over a focused search box.
    const search = fixture();
    search.look.take(
      observation({
        elements: [
          element(0, "AXTextField", "Search", 900, 300, 300, 28, {
            focused: true,
          }),
          element(1, "AXTextField", "Address and search bar", 288, 36, 720, 27),
        ],
      }),
    );
    expect((await search.find("the address bar")).region).toEqual(
      share(288, 36, 720, 27),
    );
    // A named kind with no fitting name is not a guess at any text or image.
    const plain = fixture();
    plain.look.take(
      observation({
        elements: [
          element(
            0,
            "AXStaticText",
            "A long paragraph about the week",
            90,
            90,
            900,
            200,
          ),
          element(1, "AXImage", "Company logo", 10, 10, 60, 30),
        ],
      }),
    );
    expect((await plain.find("the error message")).code).toBe("no_match");
    expect((await plain.find("the chart")).code).toBe("no_match");
    // A secure field is never a target, not even by its label.
    expect((await f.find("the passcode field")).code).toBe("no_match");
    // A field's words count too, never those of a secure field.
    expect((await f.find("fixture.test/report")).region).toEqual(
      share(288, 36, 720, 27),
    );
    expect((await f.find("hidden-fixture-word")).code).toBe("no_match");
  });

  it("finds an app or window by its name from the window list, front to back", async () => {
    const f = fixture();
    expect(await f.find("Riverchat")).toEqual({
      version: 1,
      code: "found",
      match: "window",
      region: { x: 0.5, y: 0.1, w: 0.5, h: 0.8 },
    });
    expect((await f.find("the Riverchat window")).match).toBe("window");
    expect((await f.find("ledger notes app")).region).toEqual({
      x: 0.2,
      y: 0.2,
      w: 0.4,
      h: 0.5,
    });
    // The frontmost window of the app; its title from the look also names it.
    expect((await f.find("Stonepad")).region).toEqual({
      x: 0,
      y: 0.03,
      w: 0.75,
      h: 0.95,
    });
    expect((await f.find("the quarterly fixture window")).region).toEqual({
      x: 0,
      y: 0.03,
      w: 0.75,
      h: 0.95,
    });
    // "This window" is the front window, with or without a look.
    const front = { x: 0, y: 0.03, w: 0.75, h: 0.95 };
    expect((await f.find("this window")).region).toEqual(front);
    const late = fixture();
    late.advance(LOOK_FRESH_MS + 1);
    expect((await late.find("this window")).region).toEqual(front);
    // A kind of thing is never a window, even with an app's word in it.
    expect((await f.find("the Riverchat button")).code).toBe("no_match");
    // A thing in another named app needs a look of that app.
    expect((await f.find("the Send button in Riverchat")).code).toBe("no_look");
    // In the app of the look, the app's name narrows nothing away.
    expect((await f.find("the Send button in Stonepad")).region).toEqual(
      share(1296, 810, 72, 27),
    );
  });

  it("says when nothing matches, and when there is no fresh look", async () => {
    const f = fixture();
    expect(await f.find("the Upload button")).toEqual({
      version: 1,
      code: "no_match",
      match: null,
      region: null,
    });
    f.advance(LOOK_FRESH_MS + 1);
    expect((await f.find("the Send button")).code).toBe("no_look");
    // Windows still answer without a look.
    expect((await f.find("Riverchat")).code).toBe("found");
    // The app of the look has no window on the screen any more: the look is old.
    const gone = fixture([windows[1]!]);
    expect((await gone.find("the Send button")).code).toBe("no_look");
    // The look stands only while its app has the front window.
    const behind = fixture([windows[1]!, windows[0]!]);
    expect((await behind.find("the Send button")).code).toBe("no_look");
    expect((await behind.find("Stonepad")).code).toBe("found");
    // Without a window list nothing shows that the look is still the screen.
    const blind = fixture(null);
    expect((await blind.find("the Send button")).code).toBe("no_look");
  });

  it("a picture-only look keeps the elements of the same app and surface, and drops them otherwise", async () => {
    const f = fixture();
    f.look.take(observation({ elements: [] }));
    expect((await f.find("the Send button")).code).toBe("found");
    f.look.take(observation({ elements: [], surfaceEpoch: 4 }));
    expect((await f.find("the Send button")).code).toBe("no_look");
    const g = fixture();
    g.look.take(
      observation({
        elements: [],
        app: { name: "Riverchat", bundleId: "test.riverchat", window: "" },
      }),
    );
    expect((await g.find("the Send button")).code).toBe("no_look");
  });

  it("answers carry no label, title, value or app name", async () => {
    const f = fixture();
    for (const name of [
      "the address bar",
      "the error message",
      "Riverchat",
      "the chart",
    ]) {
      const text = JSON.stringify(await f.find(name));
      for (const secret of [
        "Address",
        "fixture.test",
        "Upload",
        "Riverchat",
        "Revenue",
        "Stonepad",
        "Quarterly",
      ])
        expect(text).not.toContain(secret);
    }
  });

  it("reads the system window list with owners and places only", async () => {
    const runs: { command: string; args: string[] }[] = [];
    let stdout = JSON.stringify([
      { owner: "Riverchat", x: 0.5, y: 0.1, w: 0.5, h: 0.8 },
    ]);
    let status: number | null = 0;
    const list = systemWindows(async (command, args) => {
      runs.push({ command, args });
      return { status, stdout };
    });
    expect(await list()).toEqual([
      { owner: "Riverchat", x: 0.5, y: 0.1, w: 0.5, h: 0.8 },
    ]);
    expect(runs[0]!.command).toBe("/usr/bin/osascript");
    // No window title is read.
    expect(runs[0]!.args.join(" ")).not.toContain("kCGWindowName");
    stdout = JSON.stringify([
      { owner: "x", x: 0, y: 0, w: 1, h: 1, title: "t" },
    ]);
    expect(await list()).toBeNull();
    stdout = "not json";
    expect(await list()).toBeNull();
    status = 1;
    expect(await list()).toBeNull();
  });
});

describe("call zoom region route", () => {
  const rig = (windowList: ScreenWindow[] | null = windows) => {
    const hands = new PanelHands({ first: 41 });
    let reads = 0;
    const worker = {
      status: () => ({ enabled: true, state: "idle" }),
      run: () => ({ active: false, goal: "", step: 0, state: "idle" }),
      stop: () => ({}),
    } as unknown as ComputerWorker;
    const port = computerPort(worker, hands, {
      windows: async () => {
        reads++;
        return windowList;
      },
    });
    const desktop = {
      authorizePanel(token: string) {
        if (token !== "p".repeat(40)) throw new DomainError(401, "Denied.");
      },
    } as TaskDesktopService;
    const app = createTaskApp(
      {} as TaskService,
      "o".repeat(40),
      undefined,
      undefined,
      undefined,
      undefined,
      desktop,
      undefined,
      undefined,
      undefined,
      port,
    );
    const region = (
      body: unknown,
      headers: Record<string, string> = {},
      token = "p".repeat(40),
    ) =>
      app.request("/desktop/presentation/region", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      });
    return { hands, app, region, reads: () => reads };
  };

  it("takes the look from a hands result, without its picture, and answers with the panel credential", async () => {
    const r = rig();
    const pending = r.hands.run(
      { kind: "observe", image: true, elements: true },
      "Look",
    );
    r.hands.next(0);
    expect(
      r.hands.result({
        seq: 41,
        ok: true,
        observation: { ...observation(), image: "fixture-picture" },
      }),
    ).toBe(true);
    await pending;
    expect(JSON.stringify(r.hands.look.current())).not.toContain(
      "fixture-picture",
    );
    const answer = await r.region({ name: "the Send button" });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      version: 1,
      code: "found",
      match: "element",
      region: share(1296, 810, 72, 27),
    });
  });

  it("refuses a wrong credential before it reads, a browser origin and any other body", async () => {
    const r = rig();
    expect((await r.region({ name: "Riverchat" }, {}, "wrong")).status).toBe(
      401,
    );
    expect(r.reads()).toBe(0);
    expect(
      (
        await r.region(
          { name: "Riverchat" },
          { origin: "https://fixture.test" },
        )
      ).status,
    ).toBe(403);
    for (const bad of [
      {},
      { name: "" },
      { name: "   " },
      { name: "x".repeat(121) },
      { name: "tab\tname" },
      { name: "Riverchat", label: "extra" },
    ])
      expect((await r.region(bad)).status).toBe(400);
    expect(
      (
        await r.app.request("/desktop/presentation/region", {
          method: "POST",
          headers: { authorization: `Bearer ${"p".repeat(40)}` },
          body: "name=Riverchat",
        })
      ).status,
    ).toBe(415);
    expect(r.reads()).toBe(0);
  });

  it("is read only: it queues no command for the hands, sends no input and takes no picture", async () => {
    const r = rig();
    r.hands.look.take(observation());
    for (const name of ["the Send button", "Riverchat", "the Upload button"])
      expect((await r.region({ name })).status).toBe(200);
    // Only the window list was read, once for each request.
    expect(r.reads()).toBe(3);
    expect(r.hands.next(0)).toBeNull();
    expect(r.hands.presentationCommand()).toBe(0);
    expect(
      await (
        await r.app.request("/desktop/presentation", {
          headers: { authorization: `Bearer ${"p".repeat(40)}` },
        })
      ).json(),
    ).toEqual({ version: 1, event: null });
    // A later command still gets the next number: none was used.
    const next = r.hands.run({ kind: "wait", ms: 0 }, "Wait");
    expect(r.hands.next(0)?.seq).toBe(41);
    r.hands.result({ seq: 41, ok: true });
    await next;
  });

  it("the line's client and this route agree on the request and the answer", async () => {
    const r = rig();
    r.hands.look.take(observation());
    const service = {
      origin: "http://127.0.0.1:4100",
      instanceId: "fixture-instance",
      token: "p".repeat(40),
    };
    const request = async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      // The instance check of the line reads the service's state first.
      if (path === "/desktop/state")
        return Response.json({ instanceId: service.instanceId });
      return r.app.request(path, init);
    };
    const ask = (name: string) =>
      requestRegion(name, { discover: () => service, request });
    expect(await ask("the error message")).toEqual({
      code: "found",
      match: "element",
      region: share(432, 450, 432, 18),
    });
    expect(await ask("Riverchat")).toMatchObject({ match: "window" });
    expect(await ask("the Upload button")).toEqual({ code: "no_match" });
    service.token = "wrong".repeat(10);
    expect(await ask("Riverchat")).toEqual({ code: "unavailable" });
  });

  it("answers from the windows alone where no hands run", async () => {
    const off = offComputerPort("Off.", {
      windows: async () => windows,
    });
    expect((await off.region("Riverchat")).code).toBe("found");
    expect((await off.region("the Send button")).code).toBe("no_look");
    expect((await offComputerPort("Off.").region("Riverchat")).code).toBe(
      "no_look",
    );
  });

  it("the supervisor learns that the caller's zoom changed the call video", () => {
    const zoom = phonePresentationSchema.parse({
      kind: "zoom",
      action: "zoom",
      applied: true,
    });
    expect(presentationFact(zoom)).toMatch(/part of the screen/);
    expect(
      presentationFact({ kind: "zoom", action: "zoom", applied: false }),
    ).toMatch(/did not find what the caller named/);
    expect(
      presentationFact({ kind: "zoom", action: "overview", applied: false }),
    ).toMatch(/not applied/);
  });
});
