import { createHash, randomUUID } from "node:crypto";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { executorEnvironment } from "../codex/app-server.js";
import {
  cuaActionSchema,
  type BundledCuaConfig,
  type CuaAction,
  type CuaDevice,
  type CuaObservation,
} from "../../src/control/cua-contracts.js";

type BrowserConfig = NonNullable<BundledCuaConfig["browser"]>;
type Target = {
  testId: string | null;
  sensitive: boolean;
  editable: boolean;
  identity: string;
};
const loopback = (url: URL) =>
  ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
const parseWeb = (value: string) => {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error(
      "Computer browser requires an ordinary web URL without credentials.",
    );
  return url;
};

/** One isolated browser per task. This adapter never attaches to personal Chrome or a chat runtime. */
export class BundledCuaBrowser implements CuaDevice {
  private browser?: Browser;
  private launching?: Promise<Browser>;
  private navigation = 0;
  private context?: BrowserContext;
  private page?: Page;
  private last?: CuaObservation;
  private expiresAt = 0;
  private stopped = true;
  private fault = false;
  private readonly attempted = new Set<string>();
  private readonly origins: Set<string>;
  constructor(
    private readonly config: BrowserConfig,
    private readonly launch: typeof chromium.launch = chromium.launch.bind(
      chromium,
    ),
    private readonly now = Date.now,
  ) {
    const start = parseWeb(config.startUrl);
    this.origins = new Set(
      config.allowedOrigins.map((value) => {
        const url = parseWeb(value);
        if (url.origin !== value && `${url.origin}/` !== value)
          throw Error("Browser allowlist entries must be exact origins.");
        return url.origin;
      }),
    );
    if (!this.origins.has(start.origin))
      throw Error("Browser start URL is outside the allowed origins.");
    if (
      config.fixtureGrants.length &&
      [...this.origins].some((origin) => !loopback(new URL(origin)))
    )
      throw Error(
        "Automatic fixture grants are restricted to loopback origins.",
      );
  }
  private validUrl(value: string) {
    try {
      return this.origins.has(parseWeb(value).origin);
    } catch {
      return false;
    }
  }
  private ready(signal?: AbortSignal): Page {
    signal?.throwIfAborted();
    if (
      this.stopped ||
      this.fault ||
      !this.page ||
      this.page.isClosed() ||
      this.now() >= this.expiresAt ||
      !this.validUrl(this.page.url())
    )
      throw Error(
        "Computer browser is stopped, expired, or outside its allowed surface.",
      );
    return this.page;
  }
  async open(task: Parameters<CuaDevice["open"]>[0], signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.browser || this.page || !this.stopped)
      throw Error("Computer browser is already owned.");
    if (task.expiresAt <= this.now())
      throw Error("Computer browser grant expired.");
    this.expiresAt = task.expiresAt;
    this.stopped = false;
    this.fault = false;
    try {
      this.launching = this.launch({
        headless: this.config.headless,
        env: executorEnvironment(),
        timeout: 15_000,
      });
      try {
        this.browser = await this.launching;
      } finally {
        this.launching = undefined;
      }
      signal.throwIfAborted();
      if (this.stopped) throw Error("Computer browser stopped while opening.");
      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
        acceptDownloads: false,
        serviceWorkers: "block",
        permissions: [],
        ignoreHTTPSErrors: false,
      });
      await this.context.routeWebSocket("**/*", (socket) => socket.close());
      await this.context.route("**/*", async (route) => {
        const request = route.request();
        let ownsPage = false;
        try {
          ownsPage = request.frame().page() === this.page;
        } catch {
          /* Worker requests have no allowed page. */
        }
        if (
          this.stopped ||
          this.now() >= this.expiresAt ||
          !ownsPage ||
          !this.validUrl(request.url()) ||
          !["GET", "HEAD"].includes(request.method())
        ) {
          if (ownsPage && request.isNavigationRequest()) this.fault = true;
          await route.abort("blockedbyclient").catch(() => {});
          return;
        }
        await route.continue();
      });
      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(3000);
      this.page.setDefaultNavigationTimeout(5000);
      this.context.on("page", (page) => {
        if (page !== this.page)
          void page.close().catch(() => {
            this.fault = true;
          });
      });
      this.page.on("download", (download) => {
        this.fault = true;
        void download.cancel().catch(() => {});
      });
      this.page.on("dialog", (dialog) => {
        this.fault = true;
        void dialog.dismiss().catch(() => {});
      });
      this.page.on("filechooser", () => {
        this.fault = true;
      });
      this.page.on("framenavigated", (frame) => {
        if (frame === this.page?.mainFrame()) this.navigation++;
        if (frame === this.page?.mainFrame() && !this.validUrl(frame.url()))
          this.fault = true;
      });
      await this.page.goto(this.config.startUrl, {
        waitUntil: "domcontentloaded",
      });
      this.ready(signal);
    } catch {
      await this.stop();
      throw Error(
        "Isolated computer browser could not open. Check the installed browser and configured origin.",
      );
    }
  }
  private async target(action?: CuaAction): Promise<Target> {
    const page = this.ready();
    return page.evaluate((action) => {
      const raw =
        action && action.type !== "type"
          ? document.elementFromPoint(
              Math.min(innerWidth - 1, action.x * innerWidth),
              Math.min(innerHeight - 1, action.y * innerHeight),
            )
          : document.activeElement;
      const control =
        raw?.closest(
          "input,textarea,select,button,a,[contenteditable],[role],iframe",
        ) ?? raw;
      const tag = control?.tagName.toLowerCase() ?? "";
      const input = control instanceof HTMLInputElement ? control : null;
      const hints = [
        control?.getAttribute("name"),
        control?.id,
        control?.getAttribute("autocomplete"),
        control?.getAttribute("aria-label"),
        control?.getAttribute("placeholder"),
        control?.getAttribute("type"),
        input?.labels
          ? [...input.labels].map((label) => label.textContent).join(" ")
          : "",
      ].join(" ");
      const sensitive =
        !control ||
        tag === "iframe" ||
        (!!input &&
          ["password", "file", "email", "tel", "hidden"].includes(
            input.type,
          )) ||
        /password|passwd|credential|secret|token|api.?key|credit.?card|cc-|one.?time|otp|verification.?code|social.?security|ssn/i.test(
          hints,
        );
      const candidateId =
        raw?.closest("[data-testid]")?.getAttribute("data-testid") ?? null;
      const testId =
        candidateId && candidateId.length <= 100 ? candidateId : null;
      const editable =
        !!control &&
        (control instanceof HTMLInputElement ||
          control instanceof HTMLTextAreaElement ||
          (control instanceof HTMLElement && control.isContentEditable));
      return {
        testId,
        sensitive,
        editable,
        identity: JSON.stringify({
          tag,
          id: (control?.id ?? "").slice(0, 200),
          name: (control?.getAttribute("name") ?? "").slice(0, 200),
          type: input?.type ?? "",
          testId,
        }),
      };
    }, action);
  }
  private async controlFingerprint(page: Page): Promise<string> {
    const metadata = await page.evaluate(() => {
      const controls = document.querySelectorAll(
        "input,textarea,select,button,a,[contenteditable],[role],iframe,[data-testid]",
      );
      if (controls.length > 1000)
        throw Error("Too many controls for a bounded observation.");
      return JSON.stringify(
        [...controls].map((el) => {
          const rect = el.getBoundingClientRect();
          const input = el instanceof HTMLInputElement ? el : null;
          return [
            el.tagName,
            ...[
              "id",
              "name",
              "type",
              "data-testid",
              "autocomplete",
              "aria-label",
              "role",
              "contenteditable",
              "disabled",
              "readonly",
              "href",
            ].map((key) => (el.getAttribute(key) ?? "").slice(0, 200)),
            input?.labels
              ? [...input.labels]
                  .map((label) => label.textContent?.slice(0, 200))
                  .join(" ")
              : "",
            rect.x,
            rect.y,
            rect.width,
            rect.height,
          ];
        }),
      );
    });
    return createHash("sha256").update(metadata).digest("hex");
  }
  /** Bounded, read-only coordinate grounding. Labels never authorize an action. */
  private async visibleControls(page: Page) {
    return page.evaluate(() => {
      const targets: {
        label: string;
        tag: string;
        type: string;
        x: number;
        y: number;
        focused: boolean;
      }[] = [];
      const controls = document.querySelectorAll(
        "input,textarea,select,button,a[href],[contenteditable],[role],iframe,[data-testid]",
      );
      if (controls.length > 1000)
        throw Error("Too many controls for a bounded observation.");
      const short = (text: string | null | undefined) =>
        (text ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
      const labelText = (element: Element | null) => {
        if (
          !element ||
          element.matches(
            "input,textarea,select,[contenteditable],script,style",
          )
        )
          return "";
        const copy = element.cloneNode(true) as Element;
        copy
          .querySelectorAll(
            "input,textarea,select,[contenteditable],script,style",
          )
          .forEach((node) => node.remove());
        return short(copy.textContent);
      };
      for (const el of controls) {
        if (targets.length >= 40) break;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          style.visibility !== "visible" ||
          style.display === "none" ||
          Number(style.opacity) === 0 ||
          style.pointerEvents === "none"
        )
          continue;
        const left = Math.max(0, rect.left),
          top = Math.max(0, rect.top);
        const right = Math.min(innerWidth, rect.right),
          bottom = Math.min(innerHeight, rect.bottom);
        if (left >= right || top >= bottom) continue;
        const x = (left + right) / 2,
          y = (top + bottom) / 2;
        const hit = document.elementFromPoint(x, y);
        if (!hit || (hit !== el && !el.contains(hit))) continue;
        const field =
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement ||
          el instanceof HTMLSelectElement
            ? el
            : null;
        const labelled = (el.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/)
          .slice(0, 4)
          .map((id) => labelText(document.getElementById(id)))
          .join(" ");
        const labels = field?.labels
          ? [...field.labels].slice(0, 4).map(labelText).join(" ")
          : "";
        // Never read values, textarea contents, selected options or arbitrary page text.
        const ownLabel =
          ["BUTTON", "A"].includes(el.tagName) && el instanceof HTMLElement
            ? labelText(el)
            : "";
        const label =
          short(el.getAttribute("aria-label")) ||
          short(labelled) ||
          short(labels) ||
          short(ownLabel) ||
          short(el.getAttribute("placeholder")) ||
          short(el.getAttribute("title"));
        targets.push({
          label,
          tag: el.tagName.toLowerCase(),
          type:
            el instanceof HTMLInputElement
              ? el.type
              : (el.getAttribute("role") ?? "").slice(0, 40),
          x: Number((x / innerWidth).toFixed(6)),
          y: Number((y / innerHeight).toFixed(6)),
          focused: el === document.activeElement,
        });
      }
      return { untrusted: true, targets };
    });
  }
  private async capture(signal: AbortSignal): Promise<CuaObservation> {
    const page = this.ready(signal);
    const context = async () =>
      JSON.stringify({
        navigation: this.navigation,
        url: page.url(),
        title: (await page.title()).slice(0, 240),
        controls: await this.controlFingerprint(page),
        visibleControls: await this.visibleControls(page),
        focus: (await this.target()).identity,
      });
    const before = await context();
    const pixels = await page.screenshot({
      type: "png",
      fullPage: false,
      animations: "disabled",
      caret: "hide",
      timeout: 3000,
    });
    const after = await context();
    this.ready(signal);
    if (before !== after)
      throw Error("Computer browser changed during observation.");
    const viewport = page.viewportSize()!;
    if (pixels.length > 8 * 1024 * 1024)
      throw Error("Computer observation exceeded the image limit.");
    return {
      id: randomUUID(),
      capturedAt: this.now(),
      width: viewport.width,
      height: viewport.height,
      imageDataUrl: `data:image/png;base64,${pixels.toString("base64")}`,
      fingerprint: createHash("sha256")
        .update(pixels)
        .update(after)
        .digest("hex"),
      context: after,
    };
  }
  async observe(signal: AbortSignal) {
    const observation = await this.capture(signal);
    this.last = observation;
    return { ...observation };
  }
  async authorize(
    action: CuaAction,
    observation: CuaObservation,
  ): Promise<"allowed" | "confirm" | "refused"> {
    cuaActionSchema.parse(action);
    this.ready();
    if (
      observation.id !== this.last?.id ||
      observation.fingerprint !== this.last.fingerprint ||
      this.now() - this.last.capturedAt > 2000
    )
      return "refused";
    const target = await this.target(action);
    if (target.sensitive || (action.type === "type" && !target.editable))
      return "refused";
    const origin = new URL(this.ready().url());
    if (
      loopback(origin) &&
      this.config.fixtureGrants.some(
        (grant) =>
          grant.testId === target.testId &&
          grant.type === action.type &&
          (action.type !== "type" || grant.text === action.text),
      )
    )
      return "allowed";
    return "confirm";
  }
  async execute(
    input: Parameters<CuaDevice["execute"]>[0],
    signal: AbortSignal,
  ) {
    const page = this.ready(signal);
    const action = cuaActionSchema.parse(input.action);
    if (this.attempted.has(input.actionId))
      throw Error("Computer action was already attempted; do not retry.");
    const expected = this.last;
    if (
      !expected ||
      expected.id !== input.observationId ||
      this.now() - expected.capturedAt > 2000
    )
      throw Error("Computer observation is stale.");
    if ((await this.authorize(action, expected)) === "refused")
      throw Error("Computer input target is not permitted.");
    const fresh = await this.capture(signal);
    if (
      fresh.fingerprint !== expected.fingerprint ||
      this.now() - expected.capturedAt > 2000
    )
      throw Error("Computer surface changed; reobserve and replan.");
    this.ready(signal);
    this.attempted.add(input.actionId);
    this.last = undefined;
    const x =
      action.type === "type"
        ? 0
        : Math.min(fresh.width - 1, action.x * fresh.width);
    const y =
      action.type === "type"
        ? 0
        : Math.min(fresh.height - 1, action.y * fresh.height);
    try {
      if (action.type === "click") await page.mouse.click(x, y);
      else if (action.type === "type")
        await page.keyboard.insertText(action.text);
      else {
        await page.mouse.move(x, y);
        this.ready(signal);
        await page.mouse.wheel(0, action.deltaY);
      }
      this.ready(signal);
    } catch {
      throw Error("Computer action outcome is uncertain; do not repeat it.");
    }
  }
  async stop() {
    this.stopped = true;
    this.last = undefined;
    const launched = await this.launching?.catch(() => undefined);
    const browser = this.browser ?? launched;
    if (browser) {
      try {
        await browser.close();
      } catch {
        throw Error("Computer browser cleanup is uncertain.");
      }
    }
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
  }
}
