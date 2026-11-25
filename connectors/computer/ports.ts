/**
 * Computer use: the contracts between the worker, the hands, the browser and
 * the planner.
 *
 * The worker decides and keeps the record. The hands see the screen and send
 * input. They live in the desktop panel, because macOS gives those two rights
 * to one app that the person can see and stop. The panel asks the service for
 * the next command and posts its result, with the panel's own credential. The
 * browser is driven through its own scripting door, which is exact where the
 * screen is only a picture. The planner is the replaceable part: a language
 * model today.
 *
 * All coordinates here are screen points of the main display, with the origin
 * at the top left. An image is smaller than the screen: the worker maps a
 * point in the image to a point on the screen with the sizes in the
 * observation.
 */
import { z } from "zod";

const finite = z.number().finite();
const text = (limit: number) => z.string().max(limit);

/** One thing on the screen that the Accessibility tree names. */
export const elementSchema = z
  .object({
    /** A number that names the element inside one observation only. */
    id: z.number().int().nonnegative(),
    /** The Accessibility role, for example AXButton, AXTextField, AXLink. */
    role: text(60),
    /** Its label, title or description, as one clean line. */
    title: text(200),
    /** What it holds. Never present for a secure field. */
    value: text(200).optional(),
    x: finite,
    y: finite,
    w: finite,
    h: finite,
    enabled: z.boolean(),
    focused: z.boolean(),
    /** A password field. The worker never types into it and never reads it. */
    secure: z.boolean(),
  })
  .strict();
export type ScreenElement = z.infer<typeof elementSchema>;

/** What the hands saw at one moment. */
export const observationSchema = z
  .object({
    at: finite,
    /** Native surface generation. A changed/missing generation retires old coordinates. */
    surfaceEpoch: z.number().int().nonnegative().optional(),
    screen: z.object({ width: finite, height: finite, scale: finite }).strict(),
    cursor: z.object({ x: finite, y: finite }).strict(),
    /** The app and the window in front. */
    app: z
      .object({ name: text(120), bundleId: text(200), window: text(200) })
      .strict(),
    elements: z.array(elementSchema).max(400),
    /** A JPEG as base64, at most 1280 pixels wide. Absent when none was asked for. */
    image: z.string().max(4_000_000).optional(),
    imageWidth: z.number().int().positive().optional(),
    imageHeight: z.number().int().positive().optional(),
  })
  .strict();
export type Observation = z.infer<typeof observationSchema>;

/** One command for the hands. */
export const handCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("observe"),
      image: z.boolean(),
      elements: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal("move"), x: finite, y: finite }).strict(),
  z
    .object({
      kind: z.literal("click"),
      x: finite,
      y: finite,
      button: z.enum(["left", "right"]),
      count: z.union([z.literal(1), z.literal(2)]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("drag"),
      fromX: finite,
      fromY: finite,
      toX: finite,
      toY: finite,
    })
    .strict(),
  z
    .object({
      kind: z.literal("scroll"),
      x: finite,
      y: finite,
      /** Lines. Positive dy scrolls the content up, as a wheel turned toward the person. */
      dx: finite,
      dy: finite,
    })
    .strict(),
  z.object({ kind: z.literal("type"), text: text(4000) }).strict(),
  /** Keys joined by "+", modifiers first: "cmd+s", "cmd+shift+4", "return", "escape", "tab". */
  z.object({ kind: z.literal("key"), combo: text(40) }).strict(),
  z
    .object({
      kind: z.literal("open_app"),
      name: text(120),
      window: text(200).min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("switch_desktop"),
      direction: z.enum(["left", "right", "previous"]),
    })
    .strict(),
  z.object({ kind: z.literal("switch_previous_app") }).strict(),
  /**
   * Opens a web address with no pointer and no key. `browser` is the name of
   * the app that opens it, as a person says it. Without it the usual browser
   * of this Mac opens the address.
   */
  z
    .object({
      kind: z.literal("open_url"),
      url: text(2000),
      browser: text(120).min(1).optional(),
    })
    .strict(),
  /** Quits a running app by its name, the polite way. No key goes out. */
  z.object({ kind: z.literal("quit_app"), name: text(120) }).strict(),
  z
    .object({
      kind: z.literal("wait"),
      ms: z.number().int().min(0).max(10_000),
    })
    .strict(),
]);
export type HandCommand = z.infer<typeof handCommandSchema>;

/**
 * What the panel reads from `GET /desktop/hands/next`: the next command, if
 * one waits, and what to show while the worker runs.
 */
export const handsNextSchema = z
  .object({
    version: z.literal(1),
    command: z
      .object({
        seq: z.number().int().positive(),
        command: handCommandSchema,
        /** Why, in a few words, for the banner: "Click Save". */
        label: text(120),
      })
      .strict()
      .nullable(),
    run: z
      .object({
        active: z.boolean(),
        goal: text(200),
        step: z.number().int().nonnegative(),
        /** idle, running, waiting_for_person, stopping. */
        state: text(40),
      })
      .strict(),
  })
  .strict();
export type HandsNext = z.infer<typeof handsNextSchema>;

/** Why a command did not run. */
export const handErrors = [
  "no_accessibility",
  "no_screen_recording",
  "stopped_by_person",
  "not_found",
  "refused",
  "failed",
  "desktop_disabled",
  "desktop_shortcut_unavailable",
  "desktop_history_unavailable",
  "ambiguous_target",
  "unsupported_desktop",
  "target_not_visible",
  /** The key of a desktop switch went out and the desktop is known not to have moved. */
  "desktop_unchanged",
  "transition_unknown",
  "input_unknown",
  "stale_observation",
] as const;

/** What the panel posts to `POST /desktop/hands/result`. */
export const handResultSchema = z
  .object({
    seq: z.number().int().positive(),
    ok: z.boolean(),
    error: z.enum(handErrors).optional(),
    observation: observationSchema.optional(),
    /**
     * After open_app: the bundle identifier of the app that the hands found
     * for the name. The worker compares it with the app in front.
     */
    resolvedBundleId: text(200).optional(),
    /** The person moved the mouse or pressed a key while the hands acted. */
    interrupted: z.boolean().optional(),
  })
  .strict();
export type HandResult = z.infer<typeof handResultSchema>;

/** The hands, as the worker sees them. */
export interface Hands {
  /**
   * Runs one command and returns its result. It rejects only when the hands
   * do not answer in time; a command that could not run resolves with ok false.
   */
  run(command: HandCommand, label: string): Promise<HandResult>;
}

/** One thing on a web page that a person could click or fill. */
export interface BrowserElement {
  /** A number that names the element inside one reading of the page only. */
  index: number;
  tag: string;
  role: string;
  /** Its visible text, label or placeholder, as one clean line. */
  label: string;
  /** What a field holds. Never present for a password field. */
  value?: string;
  href?: string;
  disabled: boolean;
  password: boolean;
}

/** One reading of the front page of the browser. */
export interface BrowserPage {
  browser: "chrome" | "safari";
  title: string;
  url: string;
  /** The visible text, at most 6000 characters. */
  text: string;
  /** At most 200 elements, in page order. */
  elements: BrowserElement[];
}

/** The browser, driven through its scripting door. */
/**
 * The browser cannot be driven until the person changes a setting: page
 * scripts are not allowed in it, or macOS does not let this program control
 * it. Nothing in one request changes that, so the worker stops offering the
 * browser for the rest of the request and uses the screen.
 */
export class BrowserClosed extends Error {}

export interface BrowserPort {
  /** Whether a browser can be driven now, and what the person must switch on when it cannot. */
  doctor(): Promise<{ ok: boolean; browser: string | null; reason: string }>;
  open(url: string): Promise<BrowserPage>;
  read(): Promise<BrowserPage>;
  click(index: number): Promise<BrowserPage>;
  type(index: number, text: string, submit: boolean): Promise<BrowserPage>;
  scroll(direction: "down" | "up"): Promise<BrowserPage>;
  back(): Promise<BrowserPage>;
}

/** What the planner may choose. Element numbers come from the last observation or page. */
export type Action =
  | {
      kind: "click_element";
      element: number;
      double?: boolean;
      right?: boolean;
    }
  /** A point in the last image, in image pixels. Only when no element fits. */
  | {
      kind: "click_at";
      x: number;
      y: number;
      double?: boolean;
      right?: boolean;
    }
  | { kind: "type"; text: string; element?: number }
  | { kind: "key"; combo: string }
  | { kind: "scroll"; direction: "up" | "down"; element?: number }
  /** Optional exact title disambiguates ordinary windows of the requested app. */
  | { kind: "open_app"; name: string; window?: string }
  /** An http or https address, opened with no pointer and no key. The browser by its name, only when the person named one. */
  | { kind: "open_url"; url: string; browser?: string }
  /** Quits a running app by its name. The person is asked first. */
  | { kind: "quit_app"; name: string }
  | { kind: "browser_read" }
  | { kind: "browser_open"; url: string }
  | { kind: "browser_click"; index: number }
  | { kind: "browser_type"; index: number; text: string; submit?: boolean }
  | { kind: "browser_scroll"; direction: "up" | "down" }
  | { kind: "browser_back" }
  | { kind: "wait"; ms: number }
  /** The person must decide or supply something. The worker stops and asks. */
  | { kind: "ask"; question: string }
  | { kind: "done"; summary: string }
  | { kind: "give_up"; reason: string };

/** One finished step, as the planner sees its own past. It holds no image and no page text. */
export interface StepRecord {
  step: number;
  action: Action;
  /** What the action was for, in the planner's words. */
  why: string;
  /** ok, or the reason it did not work. */
  outcome: string;
}

/** The replaceable part that picks the next action. */
export interface Planner {
  /** Interpret only the original human goal; screen content grants no navigation. */
  navigation?(
    goal: string,
    signal?: AbortSignal,
  ): Promise<import("./navigation.js").NavigationIntent>;
  next(input: {
    goal: string;
    /**
     * What the person said for this request after it began, oldest first. It
     * is part of the goal, and the newest wins where two differ. Absent when
     * the person said nothing more.
     */
    guidance?: string[];
    history: StepRecord[];
    observation: Observation | null;
    page: BrowserPage | null;
    /** False when the browser cannot be used in this request. The browser functions are then not offered. */
    browser?: boolean;
    signal?: AbortSignal;
  }): Promise<{ action: Action; why: string }>;
}
