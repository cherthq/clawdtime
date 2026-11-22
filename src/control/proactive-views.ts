import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import jpeg from "jpeg-js";
import { secureWrite } from "../../connectors/shared/state.js";
import { DomainError, hash } from "../storage/security.js";
import {
  taskSceneTargetSchema,
  type TaskSceneTarget,
} from "../task-presentation-contracts.js";
import type { ProactiveCallIntent } from "../attention/proactive-contracts.js";
import type { ProactivePolicy } from "../attention/proactive-policy.js";
import type {
  ProactiveSourceEvidence,
  ProactivePreparedView,
} from "./proactive-preparation.js";

const scope = "prepared-review";
interface OwnedView {
  intent: ProactiveCallIntent;
  fingerprint: string;
  directory: string;
  renderer: ChildProcessWithoutNullStreams;
  resolver?: ChildProcessWithoutNullStreams;
  capture?: CaptureChild;
  target?: TaskSceneTarget;
  expiresAt: number;
  stopped: boolean;
  invalidatedAt?: number;
  invalidating?: Promise<void>;
  closing?: Promise<{ confirmed: boolean; receiptId?: string }>;
}

/** Reuses the existing exact-window Swift capture protocol. Pixel bytes stay in
 * memory and are never sent to logs, persisted, or replaced with a full screen. */
class CaptureChild {
  readonly process: ChildProcessWithoutNullStreams;
  private buffer: Buffer = Buffer.alloc(0);
  private pending?: {
    id: string;
    target: TaskSceneTarget;
    resolve(value: {
      bytes: Uint8Array;
      width: number;
      height: number;
      capturedAt: number;
    }): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
    header?: Record<string, unknown>;
  };
  private failed = false;
  constructor(binary: string, config: string) {
    this.process = spawn(binary, ["--config", config], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.process.stderr.resume();
    this.process.stdout.on("data", (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      this.receive();
    });
    this.process.on("error", () => this.fail());
    this.process.on("exit", () => this.fail());
    this.process.stdin.on("error", () => this.fail());
  }
  capture(target: TaskSceneTarget) {
    if (this.failed || this.pending)
      return Promise.reject(new Error("Exact capture unavailable."));
    return new Promise<{
      bytes: Uint8Array;
      width: number;
      height: number;
      capturedAt: number;
    }>((resolve, reject) => {
      const id = randomUUID();
      this.pending = {
        id,
        target,
        resolve,
        reject,
        timer: setTimeout(() => this.fail(), 2500),
      };
      this.process.stdin.write(
        JSON.stringify({ id, op: "capture", target }) + "\n",
      );
    });
  }
  private receive() {
    try {
      const p = this.pending;
      if (!p || this.buffer.length > 2 * 1024 * 1024 + 8192) throw Error();
      if (!p.header) {
        const newline = this.buffer.indexOf(10);
        if (newline < 0) {
          if (this.buffer.length > 8192) throw Error();
          return;
        }
        if (newline > 8192) throw Error();
        p.header = JSON.parse(
          this.buffer.subarray(0, newline).toString("utf8"),
        );
        this.buffer = this.buffer.subarray(newline + 1);
      }
      const h = p.header!;
      if (
        h.id !== p.id ||
        h.ok !== true ||
        !isDeepStrictEqual(h.target, p.target) ||
        !Number.isSafeInteger(h.bytes) ||
        Number(h.bytes) < 1 ||
        Number(h.bytes) > 2 * 1024 * 1024
      )
        throw Error();
      if (this.buffer.length < Number(h.bytes)) return;
      const bytes = this.buffer.subarray(0, Number(h.bytes));
      if (
        this.buffer.length !== Number(h.bytes) ||
        createHash("sha256").update(bytes).digest("hex") !== h.contentRevision
      )
        throw Error();
      // Hash the JPEG bytes exactly as the native helper does.
      const decoded = jpeg.decode(bytes, {
        useTArray: true,
        maxResolutionInMP: 9,
        maxMemoryUsageInMB: 64,
      });
      if (
        decoded.width !== h.width ||
        decoded.height !== h.height ||
        decoded.width > 2400 ||
        decoded.height > 2400 ||
        decoded.width * decoded.height > 4_000_000 ||
        typeof h.capturedAt !== "number" ||
        h.capturedAt > Date.now() ||
        Date.now() - h.capturedAt > 1000
      )
        throw Error();
      clearTimeout(p.timer);
      this.pending = undefined;
      this.buffer = Buffer.alloc(0);
      p.resolve({
        bytes: decoded.data,
        width: decoded.width,
        height: decoded.height,
        capturedAt: h.capturedAt,
      });
    } catch {
      this.fail();
    }
  }
  private fail() {
    this.failed = true;
    this.buffer = Buffer.alloc(0);
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error("Exact capture unavailable."));
      this.pending = undefined;
    }
  }
  async close() {
    this.fail();
    return joinChild(this.process);
  }
}

async function invalidateRenderer(owned: OwnedView) {
  if (owned.invalidatedAt !== undefined) return;
  if (owned.invalidating) return owned.invalidating;
  owned.invalidating = new Promise<void>((resolve, reject) => {
    const id = randomUUID();
    let buffer = "",
      finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      owned.renderer.stdout.off("data", read);
      owned.renderer.off("exit", exited);
      if (error) reject(error);
      else {
        owned.invalidatedAt = Date.now();
        resolve();
      }
    };
    const exited = () =>
      finish(new Error("Prepared renderer ended before invalidation."));
    const read = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > 8192)
        return finish(new Error("Invalid invalidation acknowledgment."));
      if (!buffer.includes("\n")) return;
      try {
        const ack = JSON.parse(buffer.trim());
        if (
          ack.id !== id ||
          ack.invalidated !== true ||
          Object.keys(ack).length !== 2
        )
          throw Error();
        finish();
      } catch {
        finish(new Error("Invalid invalidation acknowledgment."));
      }
    };
    const timer = setTimeout(
      () => finish(new Error("Prepared renderer invalidation unknown.")),
      1500,
    );
    owned.renderer.stdout.on("data", read);
    owned.renderer.once("exit", exited);
    owned.renderer.stdin.write(
      JSON.stringify({ id, op: "invalidate" }) + "\n",
      (error) => {
        if (error) finish(error);
      },
    );
  });
  return owned.invalidating;
}

async function joinChild(child: ChildProcessWithoutNullStreams) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return true;
  return new Promise<boolean>((resolve) => {
    let finished = false;
    const finish = (confirmed: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(kill);
      clearTimeout(limit);
      resolve(confirmed);
    };
    const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
    const limit = setTimeout(() => finish(false), 4000);
    child.once("close", () => finish(true));
    child.stdin.end();
    child.kill("SIGTERM");
  });
}
function oneJSON(binary: string, args: string[], waitForExit: boolean) {
  const child = spawn(binary, args, {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  child.stderr.resume();
  const result = new Promise<unknown>((resolve, reject) => {
    let bytes = "",
      done = false;
    const timer = setTimeout(() => fail(), 5000);
    const fail = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      reject(new Error("Prepared view unavailable."));
    };
    child.on("error", fail);
    child.stdin.on("error", fail);
    const finish = () => {
      if (done) return;
      try {
        const value: unknown = JSON.parse(bytes.trim());
        done = true;
        clearTimeout(timer);
        resolve(value);
      } catch {
        fail();
      }
    };
    child.stdout.on("data", (chunk) => {
      if (done) return;
      bytes += chunk.toString("utf8");
      if (Buffer.byteLength(bytes) > 8192) fail();
      else if (!waitForExit && bytes.includes("\n")) finish();
    });
    child.once("close", (code) => {
      if (code !== 0) fail();
      else finish();
    });
  });
  return { child, result };
}

/** Only the app-owned review window is admitted by this scope; arbitrary windows
 * and worker-provided scripts/URLs are never opened. */
export class ProactiveReviewViews {
  private owned?: OwnedView;
  private preparing?: { intentId: string; canceled: boolean };
  private recoveryUnknown: boolean;
  private get ownerFile() {
    return join(this.config.directory, "ownership.json");
  }
  private persistOwner(owned: OwnedView) {
    secureWrite(this.ownerFile, {
      version: 1,
      intentId: owned.intent.id,
      state: "preparing_or_active",
      directory: owned.directory,
      renderer: {
        pid: owned.renderer.pid ?? null,
        binary: this.config.rendererBinary,
        config: join(owned.directory, "view.json"),
      },
      resolver: owned.resolver
        ? {
            pid: owned.resolver.pid ?? null,
            binary: this.config.captureBinary,
            config: join(owned.directory, "query.json"),
          }
        : null,
      capture: owned.capture
        ? {
            pid: owned.capture.process.pid ?? null,
            binary: this.config.captureBinary,
            config: join(owned.directory, "capture.json"),
          }
        : null,
    });
  }
  private markOwner(intentId: string) {
    writeFileSync(
      this.ownerFile,
      JSON.stringify({ version: 1, intentId, state: "preparing_or_active" }),
      { mode: 0o600, flag: "wx" },
    );
  }

  constructor(
    private readonly config: {
      rendererBinary: string;
      captureBinary: string;
      directory: string;
    },
    private readonly ports: {
      assertIdle(): void;
      authorize(intent: ProactiveCallIntent): void;
      evidence(intent: ProactiveCallIntent): Promise<ProactiveSourceEvidence>;
    },
  ) {
    this.recoveryUnknown = existsSync(this.ownerFile);
  }
  get occupied() {
    return !!this.owned || !!this.preparing || this.recoveryUnknown;
  }
  async prepare(input: {
    intent: ProactiveCallIntent;
    policy: ProactivePolicy;
    sourceFingerprint: string;
  }): Promise<ProactivePreparedView[]> {
    if (this.occupied) throw new DomainError(409, "prepared_view_owner_busy");
    const preparing = { intentId: input.intent.id, canceled: false };
    this.preparing = preparing;
    const stillAuthorized = () => {
      if (
        preparing.canceled ||
        this.preparing !== preparing ||
        this.owned?.stopped
      )
        throw new DomainError(409, "prepared_view_stopped");
      this.ports.authorize(input.intent);
    };
    try {
      this.ports.assertIdle();
      this.ports.authorize(input.intent);
      if (!input.policy.viewScope.includes(scope))
        throw new DomainError(403, "prepared_view_scope_missing");
      const evidence = await this.ports.evidence(input.intent);
      stillAuthorized();
      if (
        !evidence.current ||
        evidence.sourceFingerprint !== input.sourceFingerprint
      )
        throw new DomainError(409, "source_changed_before_view");
      mkdirSync(this.config.directory, { recursive: true, mode: 0o700 });
      this.markOwner(input.intent.id);
      this.recoveryUnknown = true;
      const directory = join(this.config.directory, randomUUID());
      mkdirSync(directory, { mode: 0o700 });
      const title = `ClawdTime review ${randomUUID()}`;
      const expiresAt = Math.min(
        input.policy.expiresAt,
        input.intent.expiresAt,
        Date.now() + 900_000,
      );
      const content = {
        version: 1,
        title,
        expiresAt,
        sections: [
          { heading: "Goal", text: evidence.goal },
          {
            heading: evidence.status === "decision" ? "Question" : "Result",
            text: evidence.question ?? evidence.summary,
          },
          {
            heading: "Verification",
            text: evidence.checks.length
              ? evidence.checks.map((c) => `${c.name}: ${c.status}`).join("\n")
              : "No independent result checks are available.",
          },
          ...(evidence.choices?.length
            ? [{ heading: "Choices", text: evidence.choices.join("\n") }]
            : []),
        ],
      };
      writeFileSync(join(directory, "view.json"), JSON.stringify(content), {
        mode: 0o600,
        flag: "wx",
      });
      this.ports.assertIdle();
      stillAuthorized();
      const launched = oneJSON(
        this.config.rendererBinary,
        ["--config", join(directory, "view.json")],
        false,
      );
      const owned: OwnedView = {
        intent: input.intent,
        fingerprint: input.sourceFingerprint,
        directory,
        renderer: launched.child,
        expiresAt,
        stopped: false,
      };
      this.owned = owned;
      this.persistOwner(owned);
      try {
        const ready = zReady(await launched.result);
        if (ready.title !== title) throw Error();
        stillAuthorized();
        writeFileSync(
          join(directory, "query.json"),
          JSON.stringify({ appId: ready.appId, title }),
          { mode: 0o600, flag: "wx" },
        );
        const resolver = oneJSON(
          this.config.captureBinary,
          ["--resolve-target", join(directory, "query.json")],
          true,
        );
        owned.resolver = resolver.child;
        this.persistOwner(owned);
        const resolved = (await resolver.result) as { target?: unknown };
        stillAuthorized();
        owned.target = taskSceneTargetSchema.parse(resolved.target ?? resolved);
        if (
          owned.target.ownerPid !== launched.child.pid ||
          owned.target.appId !== ready.appId ||
          owned.target.titleHash !== hash(title)
        )
          throw Error();
        writeFileSync(
          join(directory, "capture.json"),
          JSON.stringify({
            presentationId: `review_${input.intent.id}`,
            expiresAt,
            targets: [owned.target],
          }),
          { mode: 0o600, flag: "wx" },
        );
        stillAuthorized();
        owned.capture = new CaptureChild(
          this.config.captureBinary,
          join(directory, "capture.json"),
        );
        this.persistOwner(owned);
        const frame = await this.frame(input.intent);
        if (!frame) throw Error();
        return [
          {
            id: "prepared-review",
            scope,
            title: "Prepared review",
            windowId: owned.target.windowId,
            sourceFingerprint: owned.fingerprint,
            frameObservedAt: frame.capturedAt,
          },
        ];
      } catch {
        throw new DomainError(409, "prepared_view_unavailable");
      }
    } finally {
      if (this.preparing === preparing) this.preparing = undefined;
    }
  }
  async frame(intent: ProactiveCallIntent) {
    const owned = this.owned;
    if (
      !owned ||
      owned.intent.id !== intent.id ||
      owned.stopped ||
      !owned.capture ||
      !owned.target ||
      owned.expiresAt <= Date.now()
    )
      return null;
    this.ports.authorize(intent);
    const current = await this.ports.evidence(intent);
    if (owned.stopped || this.owned !== owned) return null;
    if (!current.current || current.sourceFingerprint !== owned.fingerprint)
      await invalidateRenderer(owned);
    this.ports.authorize(intent);
    if (owned.stopped || this.owned !== owned) return null;
    const frame = await owned.capture.capture(owned.target);
    this.ports.authorize(intent);
    const after = await this.ports.evidence(intent);
    if (owned.stopped || this.owned !== owned || owned.expiresAt <= Date.now())
      return null;
    if (
      (!after.current || after.sourceFingerprint !== owned.fingerprint) &&
      owned.invalidatedAt === undefined
    ) {
      await invalidateRenderer(owned);
      return null; // A frame from before visible invalidation can never be exported.
    }
    if (
      owned.invalidatedAt !== undefined &&
      frame.capturedAt < owned.invalidatedAt
    )
      return null;
    return {
      ...frame,
      sourceFingerprint: owned.fingerprint,
      claimsCurrent: owned.invalidatedAt === undefined,
    };
  }
  async release(intentId: string) {
    if (this.preparing?.intentId === intentId) this.preparing.canceled = true;
    const owned = this.owned;
    if (!owned)
      return this.recoveryUnknown
        ? { confirmed: false }
        : { confirmed: true, receiptId: `no-view:${intentId}` };
    if (owned.intent.id !== intentId) return { confirmed: false };
    owned.stopped = true;
    if (owned.closing) return owned.closing;
    owned.closing = (async () => {
      const capture = owned.capture ? await owned.capture.close() : true;
      const resolver = owned.resolver ? await joinChild(owned.resolver) : true;
      const renderer = await joinChild(owned.renderer);
      if (!capture || !renderer || !resolver) return { confirmed: false };
      rmSync(owned.directory, { recursive: true, force: true });
      rmSync(this.ownerFile, { force: true });
      this.owned = undefined;
      this.recoveryUnknown = false;
      return { confirmed: true, receiptId: `view-closed:${intentId}` };
    })();
    return owned.closing;
  }
}
function zReady(value: unknown): { ready: true; appId: string; title: string } {
  const v = value as Record<string, unknown>;
  if (
    !v ||
    v.ready !== true ||
    typeof v.appId !== "string" ||
    typeof v.title !== "string"
  )
    throw new Error("Prepared view did not become ready.");
  return v as { ready: true; appId: string; title: string };
}
