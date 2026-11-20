import type {
  Action,
  BrowserElement,
  BrowserPage,
  BrowserPort,
  HandCommand,
  HandResult,
  Hands,
  Observation,
  Planner,
  ScreenElement,
} from "../connectors/computer/ports.js";

/** One element of a made-up screen. */
export const element = (
  id: number,
  values: Partial<ScreenElement> = {},
): ScreenElement => ({
  id,
  role: "AXButton",
  title: `Element ${id}`,
  x: 100 + id * 10,
  y: 200,
  w: 80,
  h: 24,
  enabled: true,
  focused: false,
  secure: false,
  ...values,
});

/** A made-up screen of 1440 by 900 points, shown as an image of 1280 by 800 pixels. */
export const observation = (
  elements: ScreenElement[] = [],
  values: Partial<Observation> = {},
): Observation => ({
  at: 1000,
  screen: { width: 1440, height: 900, scale: 2 },
  cursor: { x: 10, y: 10 },
  app: { name: "Notes", bundleId: "com.apple.Notes", window: "Shopping" },
  elements,
  image: "aW1hZ2U=",
  imageWidth: 1280,
  imageHeight: 800,
  ...values,
});

export const terminalApp = {
  name: "Terminal",
  bundleId: "com.apple.Terminal",
  window: "zsh",
};

/**
 * Hands that only keep a list. Each observe command takes the next screen of
 * the script; the last screen repeats. `answer` can replace the result of one
 * command. Nothing here touches a real mouse, keyboard or screen.
 */
export class FakeHands implements Hands {
  readonly commands: HandCommand[] = [];
  readonly labels: string[] = [];
  private screens: Observation[];
  /** Replaces the result of one command. Return undefined for the usual result. */
  answer: (
    command: HandCommand,
    index: number,
  ) => Partial<HandResult> | "lost" | Promise<Partial<HandResult>> | undefined =
    () => undefined;
  constructor(screens: Observation[] = [observation()]) {
    this.screens = [...screens];
  }
  /** The commands that could change the Mac: all but observe and wait. */
  get sent() {
    return this.commands.filter(
      (command) => command.kind !== "observe" && command.kind !== "wait",
    );
  }
  async run(command: HandCommand, label: string): Promise<HandResult> {
    const index = this.commands.length;
    this.commands.push(command);
    this.labels.push(label);
    const custom = await this.answer(command, index);
    if (custom === "lost") throw new Error("The hands did not answer in time.");
    const seq = index + 1;
    if (command.kind !== "observe") return { seq, ok: true, ...(custom ?? {}) };
    const screen =
      this.screens.length > 1 ? this.screens.shift()! : this.screens[0]!;
    // An observation with no image, when none was asked for.
    const { image, imageWidth, imageHeight, ...bare } = screen;
    return {
      seq,
      ok: true,
      observation: command.image
        ? screen
        : { ...bare, elements: command.elements ? bare.elements : [] },
      ...(custom ?? {}),
    };
  }
}

/** A planner that reads its actions from a list. After the list it gives up. */
export class ScriptedPlanner implements Planner {
  readonly inputs: Parameters<Planner["next"]>[0][] = [];
  private readonly script: (
    | Action
    | ((input: Parameters<Planner["next"]>[0]) => Action | Promise<Action>)
  )[];
  constructor(script: ScriptedPlanner["script"]) {
    this.script = [...script];
  }
  async next(input: Parameters<Planner["next"]>[0]) {
    this.inputs.push(input);
    const next = this.script.shift();
    const action: Action =
      next === undefined
        ? { kind: "give_up", reason: "The script ended." }
        : typeof next === "function"
          ? await next(input)
          : next;
    return { action, why: `step ${this.inputs.length}` };
  }
}

export const pageElement = (
  index: number,
  values: Partial<BrowserElement> = {},
): BrowserElement => ({
  index,
  tag: "button",
  role: "button",
  label: `Item ${index}`,
  disabled: false,
  password: false,
  ...values,
});
export const page = (
  elements: BrowserElement[] = [],
  values: Partial<BrowserPage> = {},
): BrowserPage => ({
  browser: "chrome",
  title: "Example",
  url: "https://example.com/",
  text: "Some text of the page.",
  elements,
  ...values,
});

/** A browser that only keeps a list of calls and serves one page. */
export class FakeBrowser implements BrowserPort {
  readonly calls: string[] = [];
  constructor(public current: BrowserPage = page()) {}
  async doctor() {
    return { ok: true, browser: "chrome", reason: "" };
  }
  async open(url: string) {
    this.calls.push(`open ${url}`);
    return this.current;
  }
  async read() {
    this.calls.push("read");
    return this.current;
  }
  async click(index: number) {
    this.calls.push(`click ${index}`);
    return this.current;
  }
  async type(index: number, text: string, submit: boolean) {
    this.calls.push(`type ${index} ${text} ${submit}`);
    return this.current;
  }
  async scroll(direction: "down" | "up") {
    this.calls.push(`scroll ${direction}`);
    return this.current;
  }
  async back() {
    this.calls.push("back");
    return this.current;
  }
}

/** Waits until the check holds. A test that never reaches it fails on its own timeout. */
export async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("The expected state did not come.");
    await new Promise((done) => setTimeout(done, 2));
  }
}
