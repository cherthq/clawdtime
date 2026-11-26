import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { CaptureChild } from "../../src/control/proactive-views.js";
import {
  sharedDisplayTargetSchema,
  type SharedDisplayTarget,
} from "../../src/control/proactive-display-views.js";
import { privateFolder, writePrivateJSON } from "./private-file.js";
import type { SharedResult } from "../../src/shared-relay-contracts.js";

type Capture = Pick<
  CaptureChild<SharedDisplayTarget>,
  "capture" | "close" | "process"
>;

/** Only the display selected locally during pairing. An unresolved durable
 * owner marker blocks starting another capture process after restart. */
export class SharedDisplay {
  private owned?: { callId: string; child: Capture };
  private watchdog?: ReturnType<typeof setInterval>;
  private checking = false;
  private leaseExpiresAt = 0;
  private hiding?: Promise<void>;
  private busy = false;
  private stopped = false;
  private generation = 0;
  constructor(
    private options: {
      target: SharedDisplayTarget;
      binary: string;
      directory: string;
      inspect(callId: string): Promise<{ ok: boolean; expiresAt?: number }>;
      capture?: (binary: string, config: string) => Capture;
    },
  ) {
    sharedDisplayTargetSchema.parse(options.target);
  }
  async frame(callId: string): Promise<SharedResult> {
    if (this.busy || this.stopped || this.hiding)
      return { ok: false, code: "screen_unavailable" };
    this.busy = true;
    const generation = this.generation;
    try {
      const state = await this.options.inspect(callId);
      if (
        !state.ok ||
        !state.expiresAt ||
        state.expiresAt <= Date.now() ||
        this.stopped ||
        generation !== this.generation
      )
        throw Error("expired");
      this.leaseExpiresAt = state.expiresAt;
      if (!this.owned) {
        privateFolder(this.options.directory);
        if (existsSync(join(this.options.directory, "owner.json")))
          throw Error("cleanup_unknown");
        const config = join(this.options.directory, "capture.json");
        writePrivateJSON(config, {
          presentationId: callId,
          target: this.options.target,
          expiresAt: Date.now() + 3_600_000,
        });
        writePrivateJSON(join(this.options.directory, "owner.json"), {
          callId,
          state: "starting",
        });
        const child = this.options.capture
          ? this.options.capture(this.options.binary, config)
          : new CaptureChild<SharedDisplayTarget>(
              this.options.binary,
              config,
              "--display-config",
            );
        this.owned = { callId, child };
        const ownership = this.owned;
        this.watchdog = setInterval(() => {
          if (Date.now() >= this.leaseExpiresAt) {
            void this.hide();
            return;
          }
          if (this.checking) return;
          this.checking = true;
          void this.options
            .inspect(callId)
            .then(
              async (lease) => {
                if (this.owned !== ownership) return;
                if (
                  !lease.ok ||
                  !lease.expiresAt ||
                  lease.expiresAt <= Date.now()
                )
                  await this.hide();
                else this.leaseExpiresAt = lease.expiresAt;
              },
              () => (this.owned === ownership ? this.hide() : undefined),
            )
            .finally(() => {
              this.checking = false;
            });
        }, 500);
        this.watchdog.unref();
        writePrivateJSON(join(this.options.directory, "owner.json"), {
          callId,
          pid: child.process.pid,
          state: "active",
        });
      }
      if (this.owned.callId !== callId) throw Error("other_call");
      const frame = await this.owned.child.capture(this.options.target);
      const current = await this.options.inspect(callId);
      if (
        this.stopped ||
        generation !== this.generation ||
        !current.ok ||
        !current.expiresAt ||
        current.expiresAt <= Date.now() ||
        frame.capturedAt > Date.now() + 500 ||
        Date.now() - frame.capturedAt > 1000
      )
        throw Error("expired");
      return {
        ok: true,
        frame: {
          jpeg: jpeg
            .encode(
              { data: frame.bytes, width: frame.width, height: frame.height },
              65,
            )
            .data.toString("base64"),
          width: frame.width,
          height: frame.height,
          capturedAt: frame.capturedAt,
        },
      };
    } catch {
      await this.hide();
      return { ok: false, code: "screen_unavailable" };
    } finally {
      this.busy = false;
    }
  }
  hide(): Promise<void> {
    this.generation++;
    clearInterval(this.watchdog);
    if (this.hiding) return this.hiding;
    const owned = this.owned;
    if (!owned) return Promise.resolve();
    this.hiding = (async () => {
      if (await owned.child.close()) {
        if (this.owned === owned) {
          this.owned = undefined;
          unlinkSync(join(this.options.directory, "owner.json"));
        }
      } else this.stopped = true;
    })()
      .catch(() => {
        this.stopped = true;
      })
      .finally(() => {
        this.hiding = undefined;
      });
    return this.hiding;
  }
  async close() {
    this.stopped = true;
    await this.hide();
  }
}
