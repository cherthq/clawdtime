/**
 * The setup engine: the steps of `clawdtime onboard`, separate from any
 * terminal. The terminal wizard and the Mac app drive the same operations
 * through the protocol of ./protocol.ts.
 *
 * Every step checks the real state of the Mac first, so a rerun resumes: a
 * ready step is checked again, not repeated. Nothing here is kept between
 * runs except what the steps make: the protected key store, the computer
 * switch, the pairing file and the managed connection record.
 *
 * A secret input goes only to the key check and the protected key store. A
 * phone number and a sign-in code go only to the coordinator. None of them is
 * put in an event, a log, an argument or an error.
 */
import { randomBytes } from "node:crypto";
import type { DesktopReadiness } from "../../connectors/agents/desktop-readiness.js";
import { stateRoot } from "../../connectors/agents/hooks.js";
import {
  checkKey,
  KeyStoreError,
  plannerSetup,
  storeKey,
  storeModelChoice,
} from "../../connectors/computer/keys.js";
import {
  readComputerSwitch,
  setComputerSwitch,
} from "../../connectors/computer/journal.js";
import {
  providerById,
  providers,
  type Provider,
} from "../../connectors/computer/providers.js";
import { checkCoordinator, chooseCoordinator } from "./coordinator.js";
import {
  acceptSharedInvitation,
  coordinatorPost,
  CoordinatorError,
  readSharedPairing,
  requestSharedInvitation,
  saveSharedPairing,
  sharedAcceptance,
  sharedPairingPaths,
  startSharedSignIn,
  verifySharedSignIn,
  type CoordinatorPost,
  type SharedConnection,
  type SharedDisplay,
  type SharedDisplayTarget,
} from "./pairing.js";
import {
  onboardProtocol,
  skippableSteps,
  stepIds,
  type InputRequest,
  type OnboardCommand,
  type OnboardIO,
  type Recovery,
  type ReportRow,
  type StepId,
  type StepState,
} from "./protocol.js";

/** What setup reads of the panel's and the capture helper's own access. */
export interface PermissionFacts {
  panel: {
    path?: string;
    accessibility: boolean;
    screenRecording: boolean;
  };
  capture: { path?: string; screenRecording: boolean };
}

/** Everything that touches the Mac or the network. Tests replace each one. */
export interface OnboardPorts {
  /** The Darwin major version (23 is macOS 14), or null off macOS, and whether the Mac has Apple silicon. */
  mac(): Promise<{ darwinMajor: number | null; appleSilicon: boolean }>;
  /** Whether the installed panel and capture helper are there. */
  helpers(): { panel: boolean; capture: boolean };
  desktop: {
    status(): Promise<DesktopReadiness>;
    /** The instance of the running desktop service, or null. */
    instanceId(): Promise<string | null>;
    /** Starts the desktop in local mode. It keeps an existing project. */
    start(log: (message: string) => void): Promise<void>;
    /** Starts an idle desktop again, so that it reads a new setting. Optional. */
    restart?(log: (message: string) => void): Promise<void>;
    /**
     * Ends the desktop service that setup started, and only that one.
     * Optional: setup in the Mac app ends the desktop it started when the
     * person stops setup, and any setup ends a desktop that was starting.
     */
    stop?(): Promise<void>;
    /**
     * Whether a desktop service that an app setup started (in this run or an
     * earlier one) still runs, with no foreground owner. Optional.
     */
    setupStarted?(): Promise<boolean>;
  };
  /** A fresh read-only check of the installed panel and capture helper. */
  permissions(): Promise<PermissionFacts>;
  displays: {
    list(): Promise<SharedDisplay[]>;
    resolve(displayId: string): Promise<SharedDisplayTarget>;
    /** The capture helper that the pairing saves, or undefined. */
    capture(): string | undefined;
  };
  connection: {
    /** The background connection that Terminal setup started. */
    status(instanceId: string): Promise<"running" | "stale" | "stopped">;
    /**
     * The one `clawdtime shared run` that holds the connection lock of this
     * Mac, whoever started it, or null. `managed` says that it is the one of
     * `status`.
     */
    holder(): Promise<{ instanceId: string | null; managed: boolean } | null>;
    start(instanceId: string): Promise<void>;
    stop(): Promise<void>;
  };
  /** Checks a key with its provider. It never logs the key. */
  validateKey(
    provider: Provider,
    key: string,
  ): Promise<"valid" | "refused" | "unchecked">;
  /** The network, for the coordinator. */
  request: typeof fetch;
}

export interface OnboardSettings {
  version: string;
  local: boolean;
  /**
   * The Mac app drives setup and owns the long-lived processes: setup starts
   * no background connection, and the app connects after setup.
   */
  appOwned?: boolean;
  /** The --coordinator option. */
  coordinator?: string;
  env: Record<string, string | undefined>;
  home: string;
  /** The package root: the folder of package.json and release.json. */
  root: string;
  now?: () => number;
  /** Tests only: allows http://127.0.0.1 as the coordinator. */
  allowLoopback?: boolean;
  desktopWaitMs?: number;
  pollMs?: number;
}

class Cancelled extends Error {}

const titles: Record<StepId, string> = {
  preflight: "Check this Mac",
  model: "Model key",
  desktop: "Desktop",
  computer: "Computer use",
  permissions: "Permissions",
  phone: "Your phone",
  pairing: "Pair this Mac",
  connection: "Shared connection",
  ready: "Ready",
};

const retry = (label = "Try again"): Recovery => ({ label, action: "retry" });
const accessibilityPane =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
const screenPane =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
/** The providers that setup offers: each has a default model. */
const offered = providers.filter((provider) => provider.defaultModel);

/** A phone number as the coordinator takes it: + and 7 to 15 digits. */
export function normalizePhone(raw: string): string | null {
  const compact = raw.replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{6,14}$/.test(compact) ? compact : null;
}

/** A message from an operation, only when it cannot hold a secret. */
function plain(error: unknown, fallback: string) {
  if (error instanceof KeyStoreError) return error.message;
  if (!(error instanceof Error)) return fallback;
  const text = error.message;
  return text.length <= 400 &&
    !/[A-Za-z0-9_+/=-]{32,}/.test(text) &&
    !/\+?\d[\d ]{6,}/.test(text)
    ? text
    : fallback;
}

/** What a skipped step leaves undone, and the command that finishes it. */
const later = {
  preflight:
    "The ClawdTime panel is missing, so the desktop cannot start. Install ClawdTime again, then run clawdtime onboard.",
  model:
    "No model key is stored, so ClawdTime cannot plan or chat yet. To add one later, run clawdtime onboard, or clawdtime keys set PROVIDER.",
  desktop:
    "The desktop does not run, so the chat and computer use do not work yet. To start it later, run clawdtime start, or clawdtime onboard.",
  computer: "Computer use stays off. Turn it on later: clawdtime computer on",
  permissions:
    "Screen Recording and Accessibility are not on yet, so ClawdTime cannot see or use this Mac. Turn them on in System Settings, then run clawdtime onboard.",
  phone:
    "This Mac is not paired, so calls from your phone cannot reach it. To pair it later, run clawdtime onboard.",
  pairing:
    "This Mac is not paired, so calls from your phone cannot reach it. To pair it later, run clawdtime onboard.",
  connection:
    "This Mac is not connected, so calls from your phone cannot reach it. To connect it later, run clawdtime onboard.",
} satisfies Record<Exclude<StepId, "ready">, string>;

const answers = (view: boolean, control: boolean, reports: boolean) =>
  `View ${view ? "allowed" : "declined"}. Computer actions ${control ? "allowed" : "declined"}. Reports ${reports ? "allowed" : "declined"}.`;

export class OnboardEngine {
  private rows = new Map<StepId, ReportRow>();
  private mode: "local" | "shared" = "local";
  private origin = "";
  private post: CoordinatorPost | null = null;
  private session: { token: string } | null = null;
  private paired: SharedConnection | null = null;
  private keepOther = false;
  private startedDesktop = false;
  /** A stop came while the desktop started: setup ends what that start made. */
  private stoppedWhileStarting = false;
  private computerOn = false;
  /** Every question id of this run. */
  private asked = new Set<string>();
  /**
   * The one read of the next command. A skip that waits during an operation
   * and the next question share it, so no command is ever lost.
   */
  private pendingNext: Promise<OnboardCommand> | null = null;
  /** The steps that the person skipped in this run. */
  private skippedByPerson = new Set<StepId>();
  /** The Darwin major version that preflight read (24 is macOS 15). */
  private darwin: number | null = null;
  private readonly now: () => number;
  private readonly root: string;
  private readonly pairingFiles: { directory: string; file: string };

  constructor(
    private io: OnboardIO,
    private settings: OnboardSettings,
    private ports: OnboardPorts,
  ) {
    this.now = settings.now ?? Date.now;
    this.root = stateRoot({ env: settings.env, home: settings.home });
    this.pairingFiles = sharedPairingPaths(settings.home);
  }

  /** Runs every step in order and ends with one readiness report. */
  async run(): Promise<{ ready: boolean; cancelled: boolean }> {
    this.io.emit({
      type: "hello",
      protocol: onboardProtocol,
      version: this.settings.version,
    });
    for (const id of stepIds) this.step(id, "pending");
    let cancelled = false;
    try {
      await this.proceed();
      if (await this.preflight()) {
        for (const step of [
          () => this.model(),
          () => this.desktop(),
          () => this.computer(),
          () => this.permissions(),
          () => this.phone(),
          () => this.pairing(),
          () => this.connection(),
        ]) {
          await this.proceed();
          await step();
        }
      }
    } catch (error) {
      if (error instanceof Cancelled) cancelled = true;
      else {
        const open = stepIds.find(
          (id) =>
            id !== "ready" &&
            ["in_progress", "needs_input", "pending"].includes(
              this.rows.get(id)!.state,
            ),
        );
        if (open)
          this.step(open, "failed", {
            detail:
              "This step stopped on an unexpected problem. Nothing was retried. Run clawdtime onboard again.",
          });
      }
    }
    // The app's Stop ends every process that its setup started. A stop that
    // comes while the desktop starts, in the app or in Terminal, ends the
    // desktop of that start: the start runs to its end first, so that its
    // service is known, and is never left half started with no owner.
    // In the app, a desktop that an earlier setup run started and that no
    // owner holds is setup's too: a Stop in a second run ends it.
    let stopped = false;
    if (
      cancelled &&
      (this.stoppedWhileStarting ||
        (this.settings.appOwned &&
          (this.startedDesktop || (await this.adoptable()))))
    )
      await this.ports.desktop.stop?.().then(
        () => (stopped = true),
        () => this.log("warn", "The desktop that setup started did not stop."),
      );
    const ready = !cancelled && this.finish();
    // The app learns whether a desktop that setup started runs with no
    // owner: its owner takes it on Finish, or a Stop ends it.
    const setupDesktop = this.settings.appOwned
      ? this.ports.desktop.setupStarted
        ? await this.adoptable()
        : this.startedDesktop && !stopped
      : undefined;
    this.io.emit({
      type: "done",
      ready,
      report: stepIds.map((id) => this.rows.get(id)!),
      ...(setupDesktop !== undefined ? { setupDesktop } : {}),
    });
    return { ready, cancelled };
  }

  /** A desktop that an app setup started runs, with no owner. A failed check counts as one. */
  private async adoptable() {
    if (!this.ports.desktop.setupStarted) return false;
    return this.ports.desktop.setupStarted().catch(() => true);
  }

  private step(
    id: StepId,
    state: StepState,
    more: {
      detail?: string;
      details?: string[];
      recovery?: Recovery;
      input?: InputRequest;
      question?: string;
    } = {},
  ) {
    this.rows.set(id, { id, state, detail: more.detail ?? "" });
    this.io.emit({ type: "step", id, state, title: titles[id], ...more });
  }

  /** A new question id: random, never used before in this run. */
  private newQuestion() {
    for (;;) {
      const id = randomBytes(12).toString("base64url");
      if (!this.asked.has(id)) {
        this.asked.add(id);
        return id;
      }
    }
  }

  /**
   * Waits for the one command that answers this question. A command that
   * names no open question (an earlier one, a repeated one or an unknown
   * one) is refused with no effect, and the question stays open.
   */
  private async answerTo(
    id: StepId,
    question: string,
  ): Promise<Exclude<OnboardCommand, { type: "cancel" }>> {
    for (;;) {
      const command = await this.nextCommand();
      this.pendingNext = null;
      if (command.type === "cancel") throw new Cancelled();
      if (command.question !== question) {
        this.log(
          "warn",
          "That answer is not for the question that is open now. It was ignored.",
        );
        continue;
      }
      if (command.id !== id) {
        this.log(
          "warn",
          `That command is for ${command.id}, but setup waits at ${id}. It was ignored.`,
        );
        continue;
      }
      return command;
    }
  }

  private nextCommand() {
    return (this.pendingNext ??= this.io.next());
  }

  /** Skips a step with its line. The report lists the steps that the person skipped. */
  private skipStep(id: Exclude<StepId, "ready">, detail: string = later[id]) {
    this.skippedByPerson.add(id);
    this.step(id, "skipped", { detail });
  }

  /**
   * Runs an operation of a step while the person may skip the step: the
   * step shows in progress with a question id that a skip names. The
   * operation is never abandoned: the caller decides what a skip ends.
   */
  private async whileSkippable<T>(
    id: StepId,
    detail: string,
    operation: Promise<T>,
  ): Promise<{ value: T } | { error: unknown } | "skip" | "cancel"> {
    const question = this.newQuestion();
    this.step(id, "in_progress", { detail, question });
    let over = false;
    const settled = operation.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const skipped = (async () => {
      for (;;) {
        const command = await this.nextCommand();
        // The operation ended first: the command is the next question's.
        if (over) return null;
        this.pendingNext = null;
        if (command.type === "cancel") return "cancel" as const;
        if (
          command.type === "action" &&
          command.action === "skip" &&
          command.id === id &&
          command.question === question
        )
          return "skip" as const;
        this.log(
          "warn",
          "That answer is not for the question that is open now. It was ignored.",
        );
      }
    })();
    const first = await Promise.race([settled, skipped]);
    over = true;
    return first ?? (await settled);
  }

  /** Ends the desktop that this setup started, as a skip of the desktop does. */
  private async endStartedDesktop() {
    await this.ports.desktop.stop?.().catch(() => {
      this.log("warn", "The desktop that setup started did not stop.");
    });
    this.startedDesktop = false;
  }

  private log(level: "info" | "warn", message: string) {
    this.io.emit({ type: "log", level, message });
  }

  /**
   * Goes on only while the person has not stopped setup. It runs before each
   * effect and each step, not only at a question. It first lets the input
   * that has come in be read, so a Stop that came before this moment counts.
   */
  private async proceed() {
    await new Promise((done) => setImmediate(done));
    if (this.io.cancelled()) throw new Cancelled();
  }

  /** Asks one question and waits for its answer, or for an action. */
  private async ask(
    id: StepId,
    input: InputRequest,
    view: { detail?: string; details?: string[]; recovery?: Recovery } = {},
  ): Promise<
    | { value: string | boolean | string[] }
    | { action: "retry" | "recheck" | "skip" }
  > {
    // Every answer uses up its question: a question that must be answered
    // again is asked again with a new id.
    for (;;) {
      const question = this.newQuestion();
      this.step(id, "needs_input", { ...view, input, question });
      const command = await this.answerTo(id, question);
      if (command.type === "action") {
        if (command.action === "skip" && !skippableSteps.has(id)) {
          this.log("warn", "This step cannot be skipped.");
          continue;
        }
        return { action: command.action };
      }
      const value = this.fit(input, command.value);
      if (value === undefined) {
        this.log(
          "warn",
          "That answer does not fit the question. Answer again.",
        );
        continue;
      }
      return { value };
    }
  }

  private fit(input: InputRequest, value: string | boolean | string[]) {
    if (input.kind === "confirm") {
      if (typeof value === "boolean") return value;
      if (value === "yes") return true;
      if (value === "no") return false;
      return undefined;
    }
    if (input.kind === "choice") {
      const ids = new Set((input.options ?? []).map((option) => option.id));
      if (input.multiple)
        return Array.isArray(value) && value.every((one) => ids.has(one))
          ? value
          : undefined;
      return typeof value === "string" && ids.has(value) ? value : undefined;
    }
    return typeof value === "string" ? value : undefined;
  }

  /** Shows a failure and its recovery, and waits for retry or a skip. */
  private async failed(
    id: StepId,
    detail: string,
    recovery: Recovery = retry(),
  ): Promise<"retry" | "skip"> {
    for (;;) {
      const question = this.newQuestion();
      this.step(id, "failed", { detail, recovery, question });
      const command = await this.answerTo(id, question);
      if (command.type === "action") {
        if (command.action !== "skip") return "retry";
        if (skippableSteps.has(id)) return "skip";
        this.log("warn", "This step cannot be skipped.");
        continue;
      }
      this.log("warn", "Setup waits for retry at this step. It was ignored.");
    }
  }

  private async waitForDesktop(
    until: { over: boolean } = { over: false },
  ): Promise<DesktopReadiness> {
    const deadline = this.now() + (this.settings.desktopWaitMs ?? 30_000);
    for (;;) {
      await this.proceed();
      const status = await this.ports.desktop.status();
      if (
        status.service === "connected" ||
        this.now() >= deadline ||
        until.over
      )
        return status;
      await new Promise((done) =>
        setTimeout(done, this.settings.pollMs ?? 500),
      );
    }
  }

  private async preflight(): Promise<boolean> {
    this.step("preflight", "in_progress", { detail: "Checking this Mac." });
    const mac = await this.ports.mac();
    this.darwin = mac.darwinMajor;
    if (mac.darwinMajor === null || mac.darwinMajor < 23) {
      this.step("preflight", "failed", {
        detail:
          "ClawdTime needs macOS 14 or later. Update macOS, then run clawdtime onboard again.",
      });
      return false;
    }
    if (!mac.appleSilicon) {
      this.step("preflight", "failed", {
        detail: "ClawdTime needs a Mac with Apple silicon.",
      });
      return false;
    }
    let panelSkipped = false;
    while (!this.ports.helpers().panel)
      if (
        (await this.failed(
          "preflight",
          "The ClawdTime panel is missing from this install. Install ClawdTime again, then try again.",
        )) === "skip"
      ) {
        panelSkipped = true;
        break;
      }
    let mode: string;
    if (this.settings.local) mode = "Local mode: no phone pairing.";
    else {
      const choice = chooseCoordinator({
        ...(this.settings.coordinator !== undefined
          ? { option: this.settings.coordinator }
          : {}),
        env: this.settings.env,
        root: this.settings.root,
        allowLoopback: this.settings.allowLoopback === true,
      });
      const local =
        "Setup runs in local mode. Run clawdtime onboard again later to pair your phone.";
      if (choice.kind === "none")
        mode = "No coordinator is set, so setup runs in local mode.";
      else if (choice.kind === "invalid") {
        const from = {
          option: "--coordinator",
          environment: "CLAWDTIME_COORDINATOR",
          release: "release.json",
        }[choice.source];
        mode = `The coordinator in ${from} is not an https origin, so it is not used. ${local}`;
        this.log("warn", mode);
      } else {
        await this.proceed();
        const health = await checkCoordinator(
          choice.origin,
          this.ports.request,
        );
        const at = `The coordinator at ${choice.origin}`;
        if (health.kind === "ready") {
          this.mode = "shared";
          this.origin = choice.origin;
          this.post = coordinatorPost(choice.origin, this.ports.request);
          mode = `Shared mode with ${choice.origin}.`;
          if (!health.qualified)
            this.log(
              "info",
              "Shared calls have passed automated checks only. A real call is the proof.",
            );
        } else {
          mode = {
            unavailable: `${at} did not answer. ${local}`,
            standby: `${at} takes no new Macs now. ${local}`,
            older: `${at} is older than this ClawdTime. ${local}`,
            newer: `${at} is newer than this ClawdTime. Install the newest ClawdTime to pair your phone. Setup runs in local mode.`,
          }[health.kind];
          this.log("warn", mode);
        }
      }
    }
    if (this.mode === "shared" && !this.ports.helpers().capture)
      this.log(
        "warn",
        "The capture helper is missing, so this Mac cannot show its screen on calls. Install ClawdTime again to fix it.",
      );
    if (panelSkipped) this.skipStep("preflight");
    else
      this.step("preflight", "ready", {
        detail: `macOS and Apple silicon checked. ${mode}`,
      });
    return true;
  }

  private async model() {
    const env = this.settings.env;
    for (;;) {
      const setup = plannerSetup(env, this.root);
      if (setup.ok) {
        const { provider, keyFrom } = setup.settings;
        this.step("model", "ready", {
          detail: !keyFrom
            ? `${provider.name} needs no key.`
            : keyFrom.kind === "environment"
              ? `A key for ${provider.name} is set in ${keyFrom.name}.`
              : `A key for ${provider.name} is in the protected key store.`,
        });
        return;
      }
      if (setup.reason === "invalid") {
        if (
          (await this.failed("model", `${setup.problem} Then try again.`)) ===
          "skip"
        )
          return this.skipStep("model");
        continue;
      }
      const choice = await this.ask(
        "model",
        {
          kind: "choice",
          prompt: "Which model provider do you use?",
          options: offered.map((provider) => ({
            id: provider.id,
            label: provider.name,
            detail: `Plans with ${provider.defaultModel}.`,
          })),
        },
        {
          detail:
            "ClawdTime plans each action with a language model. Your key stays on this Mac. For another provider, run clawdtime keys set PROVIDER, then run this again.",
        },
      );
      if ("action" in choice) {
        if (choice.action === "skip") return this.skipStep("model");
        continue;
      }
      const provider = providerById(choice.value as string)!;
      if ((await this.takeKey(provider)) === "skip")
        return this.skipStep("model");
    }
  }

  /** Reads, checks and stores one key. It returns to the provider choice on retry. */
  private async takeKey(provider: Provider): Promise<"skip" | undefined> {
    let detail = `Paste your ${provider.name} API key. It is not shown.`;
    for (;;) {
      const answer = await this.ask(
        "model",
        { kind: "secret", prompt: `${provider.name} API key` },
        { detail },
      );
      if ("action" in answer)
        return answer.action === "skip" ? "skip" : undefined;
      let key: string;
      try {
        key = checkKey(answer.value as string);
      } catch (error) {
        detail = plain(error, "That key cannot be used. Nothing was stored.");
        continue;
      }
      await this.proceed();
      this.step("model", "in_progress", {
        detail: `Checking the key with ${provider.name}.`,
      });
      const verdict = await this.ports
        .validateKey(provider, key)
        .catch(() => "unchecked" as const);
      if (verdict === "refused") {
        detail = `${provider.name} refused this key. Nothing was stored. Paste another key.`;
        continue;
      }
      if (verdict === "unchecked")
        this.log(
          "warn",
          `${provider.name} could not be reached to check the key. It is stored anyway.`,
        );
      await this.proceed();
      try {
        storeKey(this.root, provider, key);
        // The chosen provider plans, even when a key of another one is set.
        const after = plannerSetup(this.settings.env, this.root);
        if (
          !this.settings.env.CLAWDTIME_COMPUTER_MODEL?.trim() &&
          provider.defaultModel &&
          (!after.ok || after.settings.provider.id !== provider.id)
        )
          storeModelChoice(this.root, {
            model: `${provider.id}/${provider.defaultModel}`,
          });
      } catch (error) {
        return (await this.failed(
          "model",
          plain(error, "The key could not be stored. Nothing was changed."),
        )) === "skip"
          ? "skip"
          : undefined;
      }
      const desktop = await this.ports.desktop.status().catch(() => null);
      if (desktop?.service === "connected")
        this.log(
          "info",
          "The desktop runs already. It reads the new key the next time it starts.",
        );
      return undefined;
    }
  }

  private async desktop() {
    for (;;) {
      let status = await this.ports.desktop.status();
      if (status.service === "absent") {
        await this.proceed();
        // A start can be skipped while it runs: it goes to its end, so that
        // its service is known, and then that desktop ends.
        const starting = this.ports.desktop.start((message) =>
          this.log("info", message),
        );
        const started = await this.whileSkippable(
          "desktop",
          "Starting the desktop.",
          starting,
        );
        if (started === "skip" || started === "cancel") {
          await starting.catch(() => {});
          if (started === "cancel") {
            this.stoppedWhileStarting = true;
            throw new Cancelled();
          }
          await this.endStartedDesktop();
          return this.skipStep("desktop");
        }
        if ("error" in started) {
          await new Promise((done) => setImmediate(done));
          if (this.io.cancelled()) {
            // A start that failed may still have left its service.
            this.stoppedWhileStarting = true;
            throw new Cancelled();
          }
          if (
            (await this.failed(
              "desktop",
              plain(
                started.error,
                "The desktop did not start. Nothing was replaced.",
              ),
            )) === "skip"
          ) {
            await this.endStartedDesktop();
            return this.skipStep("desktop");
          }
          continue;
        }
        this.startedDesktop = true;
        await new Promise((done) => setImmediate(done));
        if (this.io.cancelled()) {
          this.stoppedWhileStarting = true;
          throw new Cancelled();
        }
        const until = { over: false };
        const waited = await this.whileSkippable(
          "desktop",
          "Waiting for the desktop to answer.",
          this.waitForDesktop(until),
        );
        until.over = true;
        if (waited === "cancel") {
          this.stoppedWhileStarting = true;
          throw new Cancelled();
        }
        if (waited === "skip") {
          await this.endStartedDesktop();
          return this.skipStep("desktop");
        }
        if ("error" in waited) {
          if (waited.error instanceof Cancelled)
            this.stoppedWhileStarting = true;
          throw waited.error;
        }
        status = waited.value;
      }
      if (status.service === "connected") {
        this.step("desktop", "ready", {
          detail: `${this.startedDesktop ? "The desktop started." : "The desktop runs already. Its project and work are kept."}${status.chat === "no_model" ? " It has no model key yet. It reads one the next time it starts." : ""}`,
        });
        return;
      }
      if (
        (await this.failed(
          "desktop",
          status.service === "identity_mismatch"
            ? "The running desktop does not match its own files. Nothing was replaced. Quit ClawdTime, then try again."
            : "The desktop did not answer its readiness check. Nothing was replaced. Wait a moment, then try again.",
        )) === "skip"
      ) {
        if (this.startedDesktop) await this.endStartedDesktop();
        return this.skipStep("desktop");
      }
    }
  }

  private async computer() {
    for (;;) {
      const chosen = readComputerSwitch(this.root);
      if (chosen.problem) {
        if ((await this.failed("computer", chosen.problem)) === "skip")
          return this.skipStep("computer");
        continue;
      }
      if (!chosen.enabled) {
        const answer = await this.ask(
          "computer",
          { kind: "confirm", prompt: "Turn on computer use?", consent: true },
          {
            detail:
              "ClawdTime can then see your screen, and click and type for you. Every action is checked in code. A click that cannot be undone needs your yes. Stop it any time: say stop, or press Stop work in the panel.",
          },
        );
        if ("action" in answer && answer.action !== "skip") continue;
        if ("action" in answer) return this.skipStep("computer");
        if (answer.value !== true)
          return this.step("computer", "skipped", {
            detail:
              "Computer use stays off. Turn it on later: clawdtime computer on",
          });
        await this.proceed();
        setComputerSwitch(this.root, true, this.now());
        continue;
      }
      this.computerOn = true;
      let status = await this.ports.desktop.status();
      let busy = false;
      // The desktop builds its computer worker when it starts, so a desktop
      // that started before the yes has none. It starts again, but only
      // while it is idle: no task, no unresolved action, no connection.
      if (
        status.service === "connected" &&
        status.computer === "not_configured"
      ) {
        busy =
          status.taskAdmission !== "available" ||
          (await this.ports.connection.holder()) !== null;
        if (!busy && this.ports.desktop.restart) {
          await this.proceed();
          this.step("computer", "in_progress", {
            detail: "Starting the desktop again, so that it can use this Mac.",
          });
          try {
            await this.ports.desktop.restart((message) =>
              this.log("info", message),
            );
            status = await this.waitForDesktop();
          } catch (error) {
            if (error instanceof Cancelled) throw error;
            // The owner of a foreground desktop (the Mac app) keeps it: then
            // nothing was stopped. Otherwise say how to start it.
            status = await this.ports.desktop.status();
            this.log(
              "warn",
              status.service === "connected"
                ? "The desktop was not started again. It uses computer use from its next start."
                : "The desktop did not start again. Start it yourself: clawdtime start",
            );
          }
        }
      }
      this.step("computer", "ready", {
        detail:
          status.computer === "configured"
            ? "Computer use is on."
            : busy
              ? "Computer use is on. The desktop is busy, so it uses computer use from its next start."
              : "Computer use is on. The desktop uses it from its next start.",
      });
      return;
    }
  }

  private async permissions() {
    if (!this.computerOn && this.mode === "local")
      return this.step("permissions", "skipped", {
        detail: "Computer use is off, so no permission is needed.",
      });
    for (;;) {
      await this.proceed();
      this.step("permissions", "in_progress", {
        detail: "Checking Screen Recording and Accessibility.",
      });
      let facts: PermissionFacts;
      try {
        facts = await this.ports.permissions();
      } catch {
        if (
          (await this.failed(
            "permissions",
            "The panel could not report its permissions. Install ClawdTime again, then try again.",
          )) === "skip"
        )
          return this.skipStep("permissions");
        continue;
      }
      // Each list of System Settings once, as the person sees it there, with
      // every binary that it still needs. The paths go only to the details.
      const accessibility: string[] = [];
      const screen: string[] = [];
      const paths = new Map<string, string>();
      const named = (name: string, path: string | undefined) => {
        if (path) paths.set(name, path);
        return name;
      };
      const panel = named("ClawdTimeTaskPanel", facts.panel.path);
      if (this.computerOn) {
        if (!facts.panel.accessibility) accessibility.push(panel);
        if (!facts.panel.screenRecording) screen.push(panel);
      }
      if (
        this.mode === "shared" &&
        facts.capture.path &&
        !facts.capture.screenRecording
      )
        screen.push(named("ClawdTimeTaskCapture", facts.capture.path));
      const missing = [
        {
          list: "Accessibility",
          binaries: accessibility,
          url: accessibilityPane,
        },
        { list: this.screenList(), binaries: screen, url: screenPane },
      ].filter((one) => one.binaries.length);
      if (!missing.length)
        return this.step("permissions", "ready", {
          detail: `${this.computerOn ? "Accessibility and Screen Recording are on for the panel." : "Computer use is off, so the panel needs no permission."}${this.mode === "shared" && facts.capture.path ? " Screen Recording is on for the capture helper." : ""}`,
        });
      const again = await this.ask(
        "permissions",
        { kind: "confirm", prompt: "Check again" },
        {
          detail: `In System Settings, open Privacy & Security. ${missing.map((one) => `In ${one.list}, turn on ${one.binaries.join(" and ")}.`).join(" ")} Then check again.`,
          details: [...new Set(missing.flatMap((one) => one.binaries))].flatMap(
            (name) => (paths.has(name) ? [`${name}: ${paths.get(name)}`] : []),
          ),
          recovery: {
            label: "Open System Settings",
            action: "open_settings",
            url: missing[0]!.url,
          },
        },
      );
      if ("action" in again && again.action === "skip")
        return this.skipStep("permissions");
    }
  }

  /** The name of the Screen Recording list in System Settings on this Mac. */
  private screenList() {
    return this.darwin !== null && this.darwin < 24
      ? "Screen Recording"
      : "Screen & System Audio Recording";
  }

  private localDetail() {
    return this.settings.local
      ? "Local mode. To pair your phone later, run clawdtime onboard."
      : "No coordinator is available, so this waits. Run clawdtime onboard again later.";
  }

  private async phone() {
    if (this.mode !== "shared")
      return this.step("phone", "skipped", { detail: this.localDetail() });
    for (;;) {
      const saved = readSharedPairing(this.pairingFiles.file);
      if (saved.kind === "unusable") {
        if (
          (await this.failed(
            "phone",
            `${this.pairingFiles.file} cannot be used. Look at it, then try again.`,
          )) === "skip"
        )
          return this.skipStep("phone");
        continue;
      }
      if (saved.kind === "paired") {
        if (saved.connection.origin === this.origin) {
          this.paired = saved.connection;
          return this.step("phone", "ready", {
            detail: "This Mac is paired already. No sign-in text was sent.",
          });
        }
        const answer = await this.ask("phone", {
          kind: "choice",
          consent: true,
          prompt: "This Mac is paired with another coordinator.",
          options: [
            {
              id: "keep",
              label: `Keep the pairing with ${saved.connection.origin}`,
              detail: "Nothing changes.",
            },
            {
              id: "replace",
              label: `Pair with ${this.origin} instead`,
              detail:
                "This Mac then stops using the other coordinator. A sign-in text goes out only after you ask for it.",
            },
          ],
        });
        if ("action" in answer && answer.action === "retry") continue;
        if ("action" in answer || answer.value === "keep") {
          this.keepOther = true;
          return this.step("phone", "skipped", {
            detail: `This Mac keeps its pairing with ${saved.connection.origin}.`,
          });
        }
      }
      return this.verifyPhone();
    }
  }

  /** Verifies the phone: the number, a yes, one text, the code. */
  private async verifyPhone() {
    const skipped = (detail: string) =>
      this.step("phone", "skipped", { detail });
    let recipient: string | null = null;
    let detail =
      "ClawdTime checks that the phone is yours. Your number goes only to the coordinator.";
    for (;;) {
      if (!recipient) {
        const answer = await this.ask(
          "phone",
          { kind: "phone", prompt: "Your own phone number, with country code" },
          { detail },
        );
        if ("action" in answer) {
          if (answer.action === "skip") return this.skipStep("phone");
          continue;
        }
        recipient = normalizePhone(answer.value as string);
        if (!recipient) {
          detail =
            "Write the number with its country code, for example +1 415 555 0100.";
          continue;
        }
      }
      const consent = await this.ask(
        "phone",
        {
          kind: "confirm",
          prompt: "Send a sign-in code to this number now?",
          consent: true,
        },
        {
          detail: `The coordinator at ${this.origin} texts one code to the number you gave. Nothing is sent before you say yes.`,
        },
      );
      if ("action" in consent) {
        if (consent.action === "skip")
          return this.skipStep("phone", `No text was sent. ${later.phone}`);
        recipient = null;
        continue;
      }
      if (consent.value !== true)
        return skipped(
          "No text was sent. To pair your phone later, run clawdtime onboard.",
        );
      await this.proceed();
      this.step("phone", "in_progress", {
        detail: "Asking the coordinator to send the code.",
      });
      let challenge: { challengeId: string; expiresAt?: number | undefined };
      try {
        challenge = await startSharedSignIn(this.post!, recipient);
      } catch (error) {
        const refused = error instanceof CoordinatorError ? error : null;
        const text =
          refused?.code === "identity_rate_limited"
            ? "Too many sign-in texts went to this number. Wait an hour, then try again."
            : !refused || refused.status === null
              ? "The coordinator did not answer. A text may still come. Try again to ask for a new code."
              : "The coordinator refused the sign-in. Check the number, then try again.";
        if (
          (await this.failed("phone", text, retry("Send a new code"))) ===
          "skip"
        )
          return this.skipStep("phone");
        continue;
      }
      const result = await this.enterCode(challenge);
      if (result === "skip") return this.skipStep("phone");
      if (result === "ready")
        return this.step("phone", "ready", {
          detail: "Your phone is verified.",
        });
      // "again": ask for a new code to the same number, after a new yes.
    }
  }

  private async enterCode(challenge: {
    challengeId: string;
    expiresAt?: number | undefined;
  }): Promise<"ready" | "skip" | "again"> {
    const expired = () =>
      challenge.expiresAt !== undefined && this.now() >= challenge.expiresAt;
    const again = async (text: string) =>
      (await this.failed("phone", text, retry("Send a new code"))) === "skip"
        ? ("skip" as const)
        : ("again" as const);
    let detail =
      "Enter the code from the text. If no text comes, this number may not be invited yet.";
    for (let attempts = 0; ;) {
      const answer = await this.ask(
        "phone",
        { kind: "code", prompt: "Sign-in code" },
        { detail },
      );
      if ("action" in answer)
        return answer.action === "skip" ? "skip" : "again";
      const code = (answer.value as string).replace(/[\s-]/g, "");
      if (!/^\d{4,12}$/.test(code)) {
        detail = "Enter only the digits of the code.";
        continue;
      }
      if (expired()) return again("The code expired. Ask for a new one.");
      await this.proceed();
      try {
        this.session = await verifySharedSignIn(
          this.post!,
          challenge.challengeId,
          code,
        );
        return "ready";
      } catch (error) {
        attempts++;
        if (!(error instanceof CoordinatorError) || error.status === null)
          return again(
            "The coordinator did not answer. Try again to ask for a new code.",
          );
        if (expired()) return again("The code expired. Ask for a new one.");
        if (attempts >= 5)
          return again("That code did not work five times. Ask for a new one.");
        detail = "That code did not work. Check it and enter it again.";
      }
    }
  }

  /** One consent question: yes, no, or a skip where the step allows it. */
  private async confirm(id: StepId, prompt: string, detail?: string) {
    const answer = await this.ask(
      id,
      { kind: "confirm", prompt, consent: true },
      detail ? { detail } : {},
    );
    if ("action" in answer) return answer.action === "skip" ? "skip" : false;
    return answer.value === true;
  }

  private async pairing() {
    const skipped = (detail: string) =>
      this.step("pairing", "skipped", { detail });
    if (this.mode !== "shared") return skipped(this.localDetail());
    if (this.keepOther)
      return skipped("This Mac keeps its pairing with the other coordinator.");
    if (this.paired)
      return this.step("pairing", "ready", {
        detail: `This Mac is paired. ${answers(this.paired.allowView, this.paired.allowControl, this.paired.walkthroughReports)}`,
      });
    if (!this.session)
      return skipped(
        "Your phone is not verified, so this Mac is not paired. To pair it later, run clawdtime onboard.",
      );
    for (;;) {
      let displays: SharedDisplay[] = [];
      try {
        displays = this.ports.displays.capture()
          ? await this.ports.displays.list()
          : [];
      } catch {
        displays = [];
      }
      if (!displays.length) {
        if (
          (await this.failed(
            "pairing",
            "ClawdTime cannot list the displays of this Mac. Install ClawdTime again so that it has its capture helper, then try again.",
          )) === "skip"
        )
          return this.skipStep("pairing");
        continue;
      }
      const picked = await this.ask(
        "pairing",
        {
          kind: "choice",
          prompt: "Which display may your calls show?",
          options: displays.map((display, index) => ({
            id: display.displayId,
            label: display.isMain ? "Main display" : `Display ${index + 1}`,
            detail: `${display.width} by ${display.height}`,
          })),
        },
        {
          detail:
            "Choose the display first. Then you choose what calls may do with it.",
        },
      );
      if ("action" in picked) {
        if (picked.action === "skip") return this.skipStep("pairing");
        continue;
      }
      const displayId = picked.value as string;
      const view = await this.confirm(
        "pairing",
        "Allow this display to be shown during your verified calls?",
      );
      if (view === "skip") return this.skipStep("pairing");
      let target: SharedDisplayTarget | undefined;
      if (view)
        try {
          target = await this.ports.displays.resolve(displayId);
        } catch {
          if (
            (await this.failed(
              "pairing",
              "That display is not there now. Try again to choose a display.",
            )) === "skip"
          )
            return this.skipStep("pairing");
          continue;
        }
      const control = view
        ? await this.confirm(
            "pairing",
            "Allow your verified phone to ask for computer actions on this Mac?",
            "Every action is still checked in code on this Mac.",
          )
        : false;
      if (control === "skip") return this.skipStep("pairing");
      const reports = await this.confirm(
        "pairing",
        "Allow ClawdTime to open a task result report on this Mac during your verified callbacks?",
      );
      if (reports === "skip") return this.skipStep("pairing");
      const summary = answers(view, control, reports);
      const go = await this.confirm(
        "pairing",
        "Pair this Mac with your verified account?",
        `${summary} No call is placed and no screen sharing starts now.`,
      );
      if (go !== true)
        return skipped(
          "This Mac is not paired. To pair it later, run clawdtime onboard.",
        );
      const acceptance = sharedAcceptance({
        displayId,
        shareScreen: view,
        control,
      });
      const capture = this.ports.displays.capture();
      return this.pairNow(acceptance, {
        displayId,
        walkthroughReports: reports,
        ...(view && target && capture
          ? { capture: { binary: capture, target } }
          : {}),
        summary,
      });
    }
  }

  private async pairNow(
    acceptance: ReturnType<typeof sharedAcceptance>,
    saved: {
      displayId: string;
      walkthroughReports: boolean;
      capture?: SharedConnection["capture"];
      summary: string;
    },
  ) {
    const skipped = (detail: string) =>
      this.step("pairing", "skipped", { detail });
    let replace = false;
    for (;;) {
      if (!this.session) {
        await this.verifyPhone();
        if (!this.session) return this.skipStep("pairing");
      }
      await this.proceed();
      this.step("pairing", "in_progress", { detail: "Pairing this Mac." });
      let invitation: { invitation: string };
      try {
        invitation = await requestSharedInvitation(
          this.post!,
          this.session.token,
          replace,
        );
      } catch (error) {
        const status = error instanceof CoordinatorError ? error.status : null;
        if (status === 409 && !replace) {
          const choice = await this.ask("pairing", {
            kind: "choice",
            consent: true,
            prompt: "Your number already has a paired Mac.",
            options: [
              {
                id: "replace",
                label: "Pair this Mac in its place",
                detail:
                  "The other Mac loses access at once. Its open call ends, and its tasks get no callback.",
              },
              {
                id: "keep",
                label: "Keep the other Mac",
                detail: "Nothing changes. This Mac works in local mode.",
              },
            ],
          });
          if ("action" in choice && choice.action === "retry") continue;
          if ("action" in choice || choice.value !== "replace")
            return skipped(
              "The other Mac stays paired. This Mac works in local mode.",
            );
          replace = true;
          continue;
        }
        if (status === 401 || status === 403) {
          this.session = null;
          if (
            (await this.failed(
              "pairing",
              "Your sign-in expired. Try again to verify your phone again.",
            )) === "skip"
          )
            return this.skipStep("pairing");
          continue;
        }
        if (
          (await this.failed(
            "pairing",
            status === null
              ? "The coordinator did not answer. Nothing was paired. Try again."
              : "The coordinator refused the pairing. Try again.",
          )) === "skip"
        )
          return this.skipStep("pairing");
        continue;
      }
      // The pairing that the coordinator makes next is saved even if the
      // person stops right after it: its outcome is never lost.
      await this.proceed();
      let accepted: Awaited<ReturnType<typeof acceptSharedInvitation>>;
      try {
        accepted = await acceptSharedInvitation(
          this.post!,
          invitation,
          acceptance,
        );
      } catch (error) {
        const status = error instanceof CoordinatorError ? error.status : null;
        // The answer may be lost after the coordinator paired this Mac. The
        // next try asks for a new invitation; a pairing that exists then
        // needs the person's own yes before it is replaced.
        if (
          (await this.failed(
            "pairing",
            status === null
              ? "The answer to the pairing was lost. This Mac may be paired already. Try again: setup asks before it replaces anything."
              : "The coordinator refused the pairing. Try again.",
          )) === "skip"
        )
          return skipped(
            "This Mac may not be paired. Run clawdtime onboard to check it.",
          );
        continue;
      }
      const connection: SharedConnection = {
        origin: this.origin,
        credential: accepted.credential,
        deviceId: accepted.pairing.deviceId,
        displayId: saved.displayId,
        allowView: acceptance.allowView,
        allowControl: acceptance.allowControl,
        walkthroughReports: saved.walkthroughReports,
        ...(saved.capture ? { capture: saved.capture } : {}),
      };
      saveSharedPairing(
        this.pairingFiles.directory,
        this.pairingFiles.file,
        connection,
      );
      this.paired = connection;
      return this.step("pairing", "ready", {
        detail: `This Mac is paired. ${saved.summary}`,
      });
    }
  }

  private async connection() {
    const skipped = (detail: string) =>
      this.step("connection", "skipped", { detail });
    const connected = (
      detail = "This Mac is connected to the shared number.",
    ) => this.step("connection", "ready", { detail });
    const app = this.settings.appOwned === true;
    if (this.mode !== "shared") return skipped(this.localDetail());
    if (!this.paired || this.keepOther)
      return skipped("This Mac is not paired with this coordinator.");
    for (;;) {
      const status = await this.ports.desktop.status();
      const instanceId =
        status.service === "connected"
          ? await this.ports.desktop.instanceId()
          : null;
      if (!instanceId) {
        if (
          (await this.failed(
            "connection",
            "The desktop does not run, so this Mac cannot connect. Start it with clawdtime start, then try again.",
          )) === "skip"
        )
          return this.skipStep("connection");
        continue;
      }
      // One connection per Mac: `shared run` holds a lock, and setup never
      // starts a second one next to the holder.
      const holder = await this.ports.connection.holder();
      if (holder && !holder.managed) {
        if (holder.instanceId === instanceId) return connected();
        if (
          (await this.failed(
            "connection",
            "Another connection to the shared number runs on this Mac, for an earlier desktop. End that clawdtime shared run, then try again.",
          )) === "skip"
        )
          return this.skipStep("connection");
        continue;
      }
      const state = await this.ports.connection.status(instanceId);
      if (!app && state === "running") return connected();
      const go = await this.confirm(
        "connection",
        app
          ? "Connect this Mac to the shared number when setup ends?"
          : "Connect this Mac to the shared number now?",
        app
          ? "ClawdTime keeps the connection while the app runs. Calls from your verified phone can then reach this Mac."
          : "It stays connected in the background while the desktop runs. Calls from your verified phone can then reach this Mac.",
      );
      if (go !== true) {
        if (state === "stopped")
          return go === "skip"
            ? this.skipStep("connection")
            : skipped(
                "This Mac is not connected. To connect it later, run clawdtime onboard.",
              );
        // No means not connected: the background connection that Terminal
        // setup started (or one of an earlier desktop) ends now, checked by
        // its process start and command. A report never says not connected
        // while it runs.
        await this.proceed();
        this.step("connection", "in_progress", {
          detail: "Ending the connection that runs in the background.",
        });
        try {
          await this.ports.connection.stop();
        } catch (error) {
          if (error instanceof Cancelled) throw error;
          if (
            (await this.failed(
              "connection",
              "The connection that runs in the background did not stop. Try again.",
            )) === "skip"
          )
            return skipped(
              "A connection to the shared number still runs in the background. Run setup again to end it.",
            );
          continue;
        }
        return skipped(
          "This Mac is not connected. The connection that ran in the background ended. To connect it later, run clawdtime onboard.",
        );
      }
      await this.proceed();
      this.step("connection", "in_progress", {
        detail: app
          ? "Making way for the app's connection."
          : "Connecting this Mac.",
      });
      try {
        // The app runs the one connection itself: a background one that
        // Terminal setup started ends first. In Terminal, a connection of an
        // earlier desktop lifetime ends first.
        if (state !== "stopped" && (app || state === "stale"))
          await this.ports.connection.stop();
        if (app)
          return connected(
            "ClawdTime connects this Mac to the shared number when setup ends.",
          );
        await this.proceed();
        await this.ports.connection.start(instanceId);
      } catch (error) {
        if (error instanceof Cancelled) throw error;
        if (
          (await this.failed(
            "connection",
            "The connection did not start. Try again.",
          )) === "skip"
        )
          return this.skipStep("connection");
        continue;
      }
      return connected();
    }
  }

  /**
   * The readiness report: ready when every step is ready or skipped and the
   * Mac can work (a check, a model key and a desktop). It lists each skipped
   * step: a skip is never a failure.
   */
  private finish() {
    const rows = stepIds
      .filter((id) => id !== "ready")
      .map((id) => this.rows.get(id)!);
    const required: StepId[] = ["preflight", "model", "desktop"];
    const settled = rows.every(
      (row) => row.state === "ready" || row.state === "skipped",
    );
    const ready =
      settled && required.every((id) => this.rows.get(id)!.state === "ready");
    const paired = this.rows.get("pairing")!.state === "ready";
    const connected = this.rows.get("connection")!.state === "ready";
    const skipped = rows
      .filter(
        (row) => row.state === "skipped" && this.skippedByPerson.has(row.id),
      )
      .map((row) => titles[row.id]);
    const list = skipped.length
      ? ` Skipped for now: ${skipped.join(", ")}. Run clawdtime onboard to finish ${skipped.length === 1 ? "it" : "them"}.`
      : "";
    this.step("ready", ready ? "ready" : settled ? "skipped" : "failed", {
      detail: ready
        ? (paired && connected
            ? "ClawdTime is ready on this Mac and paired with your phone. To try a call, call the shared number from your verified phone, then run clawdtime shared prove on this Mac."
            : "ClawdTime is ready on this Mac. Click the mascot to open the chat.") +
          list
        : settled
          ? `ClawdTime cannot work on this Mac yet.${list}`
          : "Setup is not finished. Run clawdtime onboard again to continue where it stopped.",
    });
    return ready;
  }
}
