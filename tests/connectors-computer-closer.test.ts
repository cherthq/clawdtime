import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closerMagnify,
  closerPart,
  check,
} from "../connectors/computer/guards.js";
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
    // The flag with no closer picture in this turn stays, and the checks refuse it.
    const lost = answer("click_at", { x: 300, y: 150, closer: true });
    const action = (await lost.planner.next(input(false))).action as Action;
    expect(action).toEqual({ kind: "click_at", x: 300, y: 150, closer: true });
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
});
