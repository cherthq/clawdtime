/**
 * The hands of the request eval (computer-request.eval.ts), and the faults
 * that can be put in front of them.
 *
 * The hands look at a page in headless Chromium and click and type there, in
 * place of the Mac. A closer look (zoom) is a larger picture of one part of
 * the page, as the panel takes it. The fault layer wraps them and changes
 * nothing of the product: a window that moves at the first looks and then
 * settles, and a screen that does not take some clicks. Nothing here
 * touches the real mouse, keyboard or screen.
 */
import type { Page } from "@playwright/test";
import type {
  HandCommand,
  HandResult,
  Hands,
  Observation,
  ScreenElement,
} from "../connectors/computer/ports.js";

// The picture is 1280 wide, as the hands send it. The screen is a 1512 by 982 display.
export const picture = { width: 1280, height: 831 };
export const display = { width: 1512, height: 982, scale: 2 };
export const toScreen = display.width / picture.width;

export interface AppInfo {
  name: string;
  bundleId: string;
  window: string;
}
/** What the screen shows: the page in front, and the app and window that it stands for. */
export interface Desk {
  page(): Page;
  app(): Promise<AppInfo>;
}

/** The keys of a combination, in the names that the browser knows. */
const keyNames: Record<string, string> = {
  cmd: "Meta",
  command: "Meta",
  ctrl: "Control",
  control: "Control",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  return: "Enter",
  enter: "Enter",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  delete: "Backspace",
  backspace: "Backspace",
  space: "Space",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  home: "Home",
  end: "End",
};

/** The hands, on a page in place of the Mac. Coordinates of a command are points of the display. */
export class PageHands implements Hands {
  private seq = 0;
  private epoch = 1;
  readonly sent: HandCommand[] = [];
  constructor(private readonly desk: Desk) {}

  private async observe(
    image: boolean,
    elements: boolean,
  ): Promise<Observation> {
    const page = this.desk.page();
    const found = elements
      ? ((await page.evaluate(`(() => {
          const out = [];
          for (const el of document.querySelectorAll("[data-role]")) {
            if (el.closest("[hidden]")) continue;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0 || r.bottom <= 0 || r.top >= innerHeight) continue;
            // What a scroll area cut off is not on the screen.
            const clip = el.closest(".sidebar, .window");
            const c = clip && clip !== el ? clip.getBoundingClientRect() : r;
            if (r.top >= c.bottom || r.bottom <= c.top) continue;
            const secure = el.type === "password";
            const field = el.tagName === "INPUT" || el.tagName === "TEXTAREA";
            const value = secure ? undefined : field ? el.value : el.dataset.value;
            out.push({ role: el.dataset.role, title: el.dataset.title || "", value: value === "" ? undefined : value,
              secure, focused: document.activeElement === el, enabled: !el.disabled,
              x: r.left, y: Math.max(r.top, c.top), w: r.width, h: Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top) });
          }
          return out;
        })()`)) as Omit<ScreenElement, "id">[])
      : [];
    const shot = image
      ? (await page.screenshot({ type: "jpeg", quality: 80 })).toString(
          "base64",
        )
      : null;
    return {
      at: Date.now(),
      surfaceEpoch: this.epoch,
      screen: display,
      cursor: { x: 700, y: 500 },
      app: await this.desk.app(),
      elements: found.map((item, index) => ({
        id: index + 1,
        role: item.role,
        title: item.title.slice(0, 200),
        ...(item.value !== undefined
          ? { value: item.value.slice(0, 200) }
          : {}),
        x: item.x * toScreen,
        y: item.y * toScreen,
        w: item.w * toScreen,
        h: item.h * toScreen,
        enabled: item.enabled,
        focused: item.focused,
        secure: item.secure,
      })),
      ...(shot
        ? {
            image: shot,
            imageWidth: picture.width,
            imageHeight: picture.height,
          }
        : {}),
    };
  }

  /** A number for a result that the fault layer gives in place of these hands. */
  nextSeq() {
    return ++this.seq;
  }

  async run(command: HandCommand): Promise<HandResult> {
    const seq = ++this.seq;
    // A look, a wait and a closer look send nothing to the app.
    if (
      command.kind !== "observe" &&
      command.kind !== "wait" &&
      command.kind !== "zoom"
    )
      this.sent.push(command);
    const page = this.desk.page();
    const at = (value: number) => value / toScreen;
    switch (command.kind) {
      case "observe":
        return {
          seq,
          ok: true,
          observation: await this.observe(command.image, command.elements),
        };
      case "wait":
        await page.waitForTimeout(Math.min(command.ms, 1500));
        return { seq, ok: true };
      case "zoom": {
        // A closer look, as the panel takes it: one part, scaled up to the asked pixels.
        const x = at(command.x),
          y = at(command.y),
          w = at(command.w),
          h = at(command.h);
        const cdp = await page.context().newCDPSession(page);
        try {
          const shot = (await cdp.send("Page.captureScreenshot", {
            format: "jpeg",
            quality: 80,
            clip: { x, y, width: w, height: h, scale: command.width / w },
          })) as { data: string };
          return {
            seq,
            ok: true,
            observation: {
              ...(await this.observe(false, false)),
              image: shot.data,
              imageWidth: command.width,
              imageHeight: command.height,
            },
          };
        } finally {
          await cdp.detach();
        }
      }
      case "move":
        await page.mouse.move(at(command.x), at(command.y));
        return { seq, ok: true };
      case "click":
        await page.mouse.click(at(command.x), at(command.y), {
          button: command.button,
          clickCount: command.count,
        });
        return { seq, ok: true };
      case "drag":
        await page.mouse.move(at(command.fromX), at(command.fromY));
        await page.mouse.down();
        await page.mouse.move(at(command.toX), at(command.toY), {
          steps: 6,
        });
        await page.mouse.up();
        return { seq, ok: true };
      case "scroll":
        await page.mouse.move(at(command.x), at(command.y));
        // Positive dy moves the content up: the wheel of the browser turns down.
        await page.mouse.wheel(command.dx * 40, command.dy * 40);
        // The wheel returns before the content moves. The next look comes after it, as on a Mac.
        await page.waitForTimeout(120);
        return { seq, ok: true };
      case "type":
        await page.keyboard.type(command.text);
        return { seq, ok: true };
      case "key": {
        const combo = command.combo
          .toLowerCase()
          .split("+")
          .map((part) => keyNames[part] ?? (part.length === 1 ? part : null));
        if (combo.some((part) => part === null))
          return { seq, ok: false, error: "refused" };
        await page.keyboard.press(combo.join("+"));
        return { seq, ok: true };
      }
      case "open_app": {
        // Only the app of this page is on this desk, and it is in front.
        const app = await this.desk.app();
        const wanted = command.name.trim().toLowerCase();
        if (wanted !== app.name.toLowerCase())
          return { seq, ok: false, error: "not_found" };
        this.epoch += 1;
        return {
          seq,
          ok: true,
          resolvedBundleId: app.bundleId,
          observation: await this.observe(true, true),
        };
      }
      default:
        return { seq, ok: false, error: "refused" };
    }
  }
}

/** Faults of the screen for one request. */
export interface HandsFaults {
  /**
   * The window moves by dx and dy pixels of the picture at each of the first
   * `looks` looks, and then stays where it is.
   */
  moving?: { looks: number; dx: number; dy: number };
  /**
   * The app does not take the first `times` clicks that land in `selector`
   * (in any place when there is none). The hands send the click and say ok,
   * as real hands do: only the next look shows that nothing changed.
   */
  deaf?: { selector?: string; times: number };
}

/** The page hands with the faults of one request in front of them. */
export class FaultyHands implements Hands {
  private looks = 0;
  private deafLeft: number;
  constructor(
    private readonly inner: PageHands,
    private readonly desk: Desk,
    private readonly faults: HandsFaults,
    private readonly applied: string[],
  ) {
    this.deafLeft = faults.deaf?.times ?? 0;
  }

  async run(command: HandCommand, label: string): Promise<HandResult> {
    const page = this.desk.page();
    const moving = this.faults.moving;
    if (command.kind === "observe" && moving && this.looks < moving.looks) {
      this.looks += 1;
      await page.evaluate(
        ([k, dx, dy]) => {
          const win = document.querySelector<HTMLElement>(".window");
          if (win)
            win.style.transform = `translate(${k! * dx!}px, ${k! * dy!}px)`;
        },
        [this.looks, moving.dx, moving.dy],
      );
      if (this.looks === moving.looks)
        this.applied.push(`window moved at the first ${moving.looks} looks`);
    }
    if (command.kind === "click" && this.deafLeft > 0) {
      const hit = await page.evaluate(
        ({ x, y, selector }) => {
          const el = document.elementFromPoint(x, y);
          return (
            el !== null && (selector === "" || el.closest(selector) !== null)
          );
        },
        {
          x: command.x / toScreen,
          y: command.y / toScreen,
          selector: this.faults.deaf?.selector ?? "",
        },
      );
      if (hit) {
        this.deafLeft -= 1;
        this.inner.sent.push(command);
        this.applied.push("a click was not taken");
        return { seq: this.inner.nextSeq(), ok: true };
      }
    }
    return this.inner.run(command);
  }
}
