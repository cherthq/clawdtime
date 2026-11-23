import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closerMagnify,
  closerPart,
  check,
} from "../connectors/computer/guards.js";
import {
  closerLimit,
  closerLimitText,
  closerSecureText,
  closerShowsSecure,
  fromCloserPicture,
} from "../connectors/computer/closer.js";
import { ComputerJournal } from "../connectors/computer/journal.js";
import { OpenAIPlanner } from "../connectors/computer/planner.js";
import type {
  Action,
  Closer,
  HandCommand,
} from "../connectors/computer/ports.js";
import { handCommandSchema } from "../connectors/computer/ports.js";
import { ComputerWorker } from "../connectors/computer/worker.js";
import {
  FakeHands,
  ScriptedPlanner,
  element,
  observation,
} from "./connectors-computer-fixture.js";

// The fixture's screen: 1440 by 900 points, a picture of 1280 by 800 pixels.
const seen = observation();

describe("a closer look", () => {
  it("shows a quarter of the picture around the point, kept inside the picture, three times larger", () => {
    const part = closerPart({ x: 640, y: 400 }, seen)!;
    expect(part.region).toEqual({ x: 480, y: 300, w: 320, h: 200 });
    expect(part.command).toEqual({
      kind: "zoom",
      x: 540,
      y: 337.5,
      w: 360,
      h: 225,
      width: 320 * closerMagnify,
      height: 200 * closerMagnify,
    });
    expect(handCommandSchema.parse(part.command)).toEqual(part.command);
    // Near a corner the part moves inside the picture; it keeps its size.
    expect(closerPart({ x: 5, y: 790 }, seen)!.region).toEqual({
      x: 0,
      y: 600,
      w: 320,
      h: 200,
    });
    expect(closerPart({ x: 1279, y: 0 }, seen)!.region).toEqual({
      x: 960,
      y: 0,
      w: 320,
      h: 200,
    });
    // No picture, or a point outside it: no closer look.
    expect(closerPart({ x: 10, y: 10 }, null)).toBeNull();
    const { image, imageWidth, imageHeight, ...bare } = seen;
    expect(closerPart({ x: 10, y: 10 }, bare)).toBeNull();
    expect(closerPart({ x: 1281, y: 10 }, seen)).toBeNull();
    expect(closerPart({ x: -1, y: 10 }, seen)).toBeNull();
    expect(closerPart({ x: Number.NaN, y: 10 }, seen)).toBeNull();
  });

  it("is checked as a look: it runs with no question, and is refused with no picture", () => {
    const view = {
      observation: seen,
      page: null,
      fresh: true,
      browser: false,
      goal: "Give it three stars",
    };
    const checked = check({ kind: "look_closer", x: 640, y: 400 }, view, "");
    expect(checked).toMatchObject({
      verdict: "run",
      label: "Look closer",
      risk: null,
      send: { via: "hands", look: false, command: { kind: "zoom" } },
    });
    expect(
      check(
        { kind: "look_closer", x: 640, y: 400 },
        { ...view, observation: null },
        "",
      ),
    ).toMatchObject({
      verdict: "refuse",
    });
    // A click with the closer flag that the planner could not map is no action.
    expect(
      check({ kind: "click_at", x: 10, y: 10, closer: true }, view, ""),
    ).toMatchObject({ verdict: "refuse" });
  });

  it("never shows a password field larger", () => {
    // The part around 640,400 is 540,337.5 to 900,562.5 in screen points.
    const password = element(7, {
      role: "AXSecureTextField",
      title: "Password",
      secure: true,
      x: 600,
      y: 420,
      w: 200,
      h: 24,
    });
    const view = {
      observation: observation([password]),
      page: null,
      fresh: true,
      browser: false,
      goal: "Sign in",
    };
    expect(check({ kind: "look_closer", x: 640, y: 400 }, view, "")).toEqual({
      verdict: "refuse",
      reason: closerSecureText,
    });
    // Just outside the part, but within the margin around the field.
    const near = observation([{ ...password, x: 905, y: 420 }]);
    expect(
      check(
        { kind: "look_closer", x: 640, y: 400 },
        { ...view, observation: near },
        "",
      ),
    ).toMatchObject({ verdict: "refuse" });
    // Far from the part: the look runs.
    const far = observation([{ ...password, x: 100, y: 800 }]);
    expect(
      check(
        { kind: "look_closer", x: 640, y: 400 },
        { ...view, observation: far },
        "",
      ),
    ).toMatchObject({ verdict: "run" });
    // The look after the zoom decides too; with no picture to map, the picture stays back.
    const closer: Closer = {
      image: "Y2xvc2Vy",
      imageWidth: 960,
      imageHeight: 600,
      region: { x: 480, y: 300, w: 320, h: 200 },
    };
    expect(closerShowsSecure(closer, far)).toBe(false);
    expect(closerShowsSecure(closer, observation([password]))).toBe(true);
    expect(closerShowsSecure(closer, null)).toBe(true);
    const { image, imageWidth, imageHeight, ...bare } = far;
    expect(closerShowsSecure(closer, bare)).toBe(true);
  });

  it("maps only a click with the flag, and leaves every other action as it is", () => {
    const closer: Closer = {
      image: "Y2xvc2Vy",
      imageWidth: 960,
      imageHeight: 600,
      region: { x: 480, y: 300, w: 320, h: 200 },
    };
    const key: Action = { kind: "key", combo: "cmd+a" };
    expect(fromCloserPicture(key, closer)).toEqual({ action: key });
    const plain: Action = { kind: "click_at", x: 5, y: 6 };
    expect(fromCloserPicture(plain, closer)).toEqual({ action: plain });
    // The edges of the closer picture are the edges of its part.
    const edge = { kind: "click_at", x: 960, y: 600, closer: true } as Action;
    expect(fromCloserPicture(edge, closer)).toEqual({
      action: { kind: "click_at", x: 800, y: 500 },
    });
    // A flag that is no boolean is left for the check of the arguments.
    const odd = {
      kind: "click_at",
      x: 1,
      y: 1,
      closer: "yes",
    } as unknown as Action;
    expect(fromCloserPicture(odd, closer)).toEqual({ action: odd });
  });
});

describe("the planner with a closer look", () => {
  const closer: Closer = {
    image: "Y2xvc2Vy",
    imageWidth: 960,
    imageHeight: 600,
    region: { x: 480, y: 300, w: 320, h: 200 },
  };
  const answer = (name: string, args: Record<string, unknown>) => {
    const sent: {
      messages: { content: unknown }[];
      tools: { function: { name: string } }[];
    }[] = [];
    const request: typeof fetch = async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  { function: { name, arguments: JSON.stringify(args) } },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    };
    return { sent, planner: new OpenAIPlanner({ key: "k", request }) };
  };
  const input = (withCloser: boolean) => ({
    goal: "Give the review three stars",
    history: [],
    observation: seen,
    page: null,
    ...(withCloser ? { closer } : {}),
  });

  it("offers look_closer, and sends the closer picture as a second picture with what it shows", async () => {
    const { sent, planner } = answer("look_closer", { x: 640, y: 400 });
    expect((await planner.next(input(false))).action).toEqual({
      kind: "look_closer",
      x: 640,
      y: 400,
    });
    expect(sent[0]!.tools.map((tool) => tool.function.name)).toContain(
      "look_closer",
    );
    const parts = sent[0]!.messages[1]!.content as { type: string }[];
    expect(parts.filter((part) => part.type === "image_url")).toHaveLength(1);

    const second = answer("done", { summary: "x" });
    await second.planner.next(input(true));
    const content = second.sent[0]!.messages[1]!.content as {
      type: string;
      text?: string;
      image_url?: { url: string };
    }[];
    const pictures = content.filter((part) => part.type === "image_url");
    expect(pictures).toHaveLength(2);
    expect(pictures[1]!.image_url!.url).toBe("data:image/jpeg;base64,Y2xvc2Vy");
    expect(content[0]!.text).toContain(
      "the second picture is the part of the first picture from 480,300 to 800,500",
    );
  });

  it("turns a click in the closer picture into a click in the first picture", async () => {
    const { planner } = answer("click_at", { x: 300, y: 150, closer: true });
    // 480 + 300 * 320 / 960 = 580; 300 + 150 * 200 / 600 = 350.
    expect((await planner.next(input(true))).action).toEqual({
      kind: "click_at",
      x: 580,
      y: 350,
    });
    // A plain click stays as it is, and closer false is left out.
    const plain = answer("click_at", { x: 12, y: 34, closer: false });
    expect((await plain.planner.next(input(true))).action).toEqual({
      kind: "click_at",
      x: 12,
      y: 34,
    });
  });

  it("sends a click in a closer picture that is not there back to the model, and never guesses the point", async () => {
    // No closer picture in this turn: the model is told once, then it fails.
    const lost = answer("click_at", { x: 300, y: 150, closer: true });
    await expect(lost.planner.next(input(false))).rejects.toMatchObject({
      trouble: "malformed",
      message: expect.stringContaining("closer_point"),
    });
    expect(lost.sent).toHaveLength(2);
    expect(JSON.stringify(lost.sent[1]!.messages.at(-1))).toContain(
      "There is no closer picture in this turn.",
    );
    // A point outside the closer picture is no point of the first picture.
    const outside = answer("click_at", { x: 961, y: 10, closer: true });
    await expect(outside.planner.next(input(true))).rejects.toMatchObject({
      trouble: "malformed",
    });
    expect(JSON.stringify(outside.sent[1]!.messages.at(-1))).toContain(
      "The point is not inside the closer picture of 960 by 600 pixels.",
    );
  });
});

describe("the worker with a closer look", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  it("sends the zoom, gives the picture to the next turn only, and sends no input for it", async () => {
    const home = mkdtempSync(join(tmpdir(), "clawdtime-closer-"));
    roots.push(home);
    const hands = new FakeHands([seen]);
    hands.answer = (command: HandCommand) =>
      command.kind === "zoom"
        ? {
            ok: true,
            observation: {
              ...seen,
              elements: [],
              image: "Y2xvc2Vy",
              imageWidth: 960,
              imageHeight: 600,
            },
          }
        : undefined;
    const planner = new ScriptedPlanner([
      { kind: "look_closer", x: 640, y: 400 },
      { kind: "click_at", x: 580, y: 350 },
      { kind: "done", summary: "Three stars." },
    ]);
    const worker = new ComputerWorker({
      hands,
      planner,
      journal: new ComputerJournal(home, () => 1_000_000),
      now: () => 1_000_000,
      notify: () => {},
    });
    await worker.submit("r1", "Give the review three stars");
    await worker.idle();
    const zoom = hands.commands.find((command) => command.kind === "zoom");
    expect(zoom).toEqual(closerPart({ x: 640, y: 400 }, seen)!.command);
    expect(hands.labels[hands.commands.indexOf(zoom!)]).toBe("Look closer");
    // The turn after the look has the picture; the turns before and after it do not.
    expect(planner.inputs.map((input) => input.closer?.image ?? null)).toEqual([
      null,
      "Y2xvc2Vy",
      null,
    ]);
    expect(planner.inputs[1]!.closer!.region).toEqual({
      x: 480,
      y: 300,
      w: 320,
      h: 200,
    });
    expect(planner.inputs[1]!.history.at(-1)).toMatchObject({
      action: { kind: "look_closer" },
      outcome: "ok: the closer picture comes with this turn",
    });
    expect(hands.sent.map((command) => command.kind)).toEqual([
      "zoom",
      "click",
    ]);
    expect(worker.status().state).toBe("completed");
  });

  const workerWith = (hands: FakeHands, planner: ScriptedPlanner) => {
    const home = mkdtempSync(join(tmpdir(), "clawdtime-closer-"));
    roots.push(home);
    const journal = new ComputerJournal(home, () => 1_000_000);
    const worker = new ComputerWorker({
      hands,
      planner,
      journal,
      now: () => 1_000_000,
      notify: () => {},
    });
    return { worker, journal };
  };
  const zoomed = (command: HandCommand) =>
    command.kind === "zoom"
      ? {
          ok: true,
          observation: {
            ...seen,
            elements: [],
            image: "Y2xvc2Vy",
            imageWidth: 960,
            imageHeight: 600,
          },
        }
      : undefined;

  it("sends at most a few closer looks for each request", async () => {
    const hands = new FakeHands([seen]);
    hands.answer = zoomed;
    const looks = Array.from({ length: closerLimit + 1 }, (_, index) => ({
      kind: "look_closer" as const,
      x: 100 + index * 100,
      y: 400,
    }));
    const planner = new ScriptedPlanner([
      ...looks,
      { kind: "done", summary: "Seen." },
    ]);
    const { worker } = workerWith(hands, planner);
    await worker.submit("r1", "Give the review three stars");
    await worker.idle();
    expect(
      hands.commands.filter((command) => command.kind === "zoom"),
    ).toHaveLength(closerLimit);
    expect(planner.inputs.at(-1)!.history.at(-1)).toMatchObject({
      action: { kind: "look_closer" },
      outcome: `refused: ${closerLimitText}`,
    });
    expect(worker.status().state).toBe("completed");
  });

  it("keeps the closer picture back when a password field is in its part in the next look", async () => {
    const password = element(7, {
      role: "AXSecureTextField",
      title: "Password",
      secure: true,
      x: 600,
      y: 420,
      w: 200,
      h: 24,
    });
    // The first look has no password field; the look after the zoom has one.
    const hands = new FakeHands([seen, observation([password])]);
    hands.answer = zoomed;
    const planner = new ScriptedPlanner([
      { kind: "look_closer", x: 640, y: 400 },
      { kind: "give_up", reason: "Stop here." },
    ]);
    const { worker } = workerWith(hands, planner);
    await worker.submit("r1", "Sign in");
    await worker.idle();
    expect(
      hands.commands.filter((command) => command.kind === "zoom"),
    ).toHaveLength(1);
    expect(planner.inputs[1]!.closer).toBeUndefined();
    expect(planner.inputs[1]!.history.at(-1)).toMatchObject({
      action: { kind: "look_closer" },
      outcome: `not shown: ${closerSecureText}`,
    });
  });

  it("is a look: a closer picture that never comes back makes nothing uncertain", async () => {
    const hands = new FakeHands([seen]);
    hands.answer = (command) => (command.kind === "zoom" ? "lost" : undefined);
    const planner = new ScriptedPlanner([
      { kind: "look_closer", x: 640, y: 400 },
    ]);
    const { worker, journal } = workerWith(hands, planner);
    await worker.submit("r1", "Give the review three stars");
    await worker.idle();
    // A lost click would be uncertain. A lost look is only a silent panel.
    expect(worker.snapshot().state).toBe("blocked");
    expect(journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "hands_silent",
    });
  });
});
