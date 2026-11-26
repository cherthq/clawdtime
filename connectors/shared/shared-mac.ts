import { z } from "zod";
import {
  sharedCommandSchema,
  sharedResultSchema,
  type SharedCommand,
  type SharedResult,
} from "../../src/shared-relay-contracts.js";
import { Store } from "../../src/storage/store.js";
import { hash } from "../../src/storage/security.js";
import { routingId } from "../../src/shared-number-contracts.js";

export function sharedOrigin(raw: string, allowLoopback = false) {
  const url = new URL(raw);
  if (
    (url.protocol !== "https:" &&
      !(
        allowLoopback &&
        url.protocol === "http:" &&
        url.hostname === "127.0.0.1"
      )) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw Error("shared_origin_required");
  return url.origin;
}

/** A foreground connection to one coordinator and one desktop instance.
 * Any lost transport is terminal for this process. Reconnect is explicit and
 * cannot replay old commands. Only fixed phone operations reach the desktop. */
export class SharedMac {
  constructor(
    private options: {
      origin: string;
      credential: string;
      instanceId: string;
      deviceId: string;
      store: Store;
      request?: typeof fetch;
      allowLoopback?: boolean;
      execute(
        command: SharedCommand,
        signal: AbortSignal,
      ): Promise<SharedResult>;
      closeCall(callId: string): Promise<void>;
      completions?(): { taskId: string; resultId: string }[];
    },
  ) {
    sharedOrigin(options.origin, options.allowLoopback);
  }
  async run(signal: AbortSignal) {
    const stop = new AbortController();
    const combined = AbortSignal.any([signal, stop.signal]);
    const calls = new Set<string>();
    const active = new Set<Promise<void>>();
    const post = async (path: string, data: unknown) => {
      const response = await (this.options.request ?? fetch)(
        `${this.options.origin}${path}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.credential}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(data),
          redirect: "error",
          signal: AbortSignal.any([combined, AbortSignal.timeout(15_000)]),
        },
      );
      if (!response.ok) throw Error("shared_connection_refused");
      return response.json();
    };
    const connection = z
      .object({
        id: routingId,
        deviceId: routingId,
        desktopInstanceId: routingId,
      })
      .parse(
        await post("/device/connect", { instanceId: this.options.instanceId }),
      );
    if (
      connection.deviceId !== this.options.deviceId ||
      connection.desktopInstanceId !== this.options.instanceId
    )
      throw Error("shared_connection_changed");
    const completions = async () => {
      for (const result of this.options.completions?.() ?? []) {
        const receipt = this.options.store.get<{ id: string; state: string }>(
          "shared_mac_delivery",
          result.taskId,
        );
        if (
          receipt?.state !== "finished" ||
          this.options.store.get("shared_mac_completion", result.taskId)
        )
          continue;
        // The server commits task/result ownership idempotently. Retrying this
        // receipt cannot place a call or replay the original task.
        await post("/device/completion", {
          ...result,
          connectionId: connection.id,
        });
        this.options.store.put("shared_mac_completion", {
          id: result.taskId,
          resultId: result.resultId,
        });
      }
    };
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void post("/device/heartbeat", { connectionId: connection.id })
        .then(completions)
        .catch(() => stop.abort())
        .finally(() => {
          renewing = false;
        });
    }, 5_000);
    timer.unref();
    const execute = async (command: SharedCommand) => {
      if (
        combined.aborted ||
        command.deviceId !== this.options.deviceId ||
        command.instanceId !== this.options.instanceId ||
        command.connectionId !== connection.id ||
        command.expiresAt <= Date.now()
      )
        throw Error("shared_command_stale");
      const fingerprint = hash(JSON.stringify(command));
      const prior = this.options.store.get<{ id: string; fingerprint: string }>(
        "shared_mac_delivery",
        command.id,
      );
      let result: SharedResult = { ok: false, code: "outcome_unknown" };
      if (prior && prior.fingerprint !== fingerprint)
        throw Error("shared_command_conflict");
      if (!prior) {
        this.options.store.put("shared_mac_delivery", {
          id: command.id,
          fingerprint,
          state: "started",
        });
        if (command.operation.action === "open") calls.add(command.callId);
        try {
          result = sharedResultSchema.parse(
            await this.options.execute(
              command,
              AbortSignal.any([
                combined,
                AbortSignal.timeout(
                  Math.max(1, command.expiresAt - Date.now()),
                ),
              ]),
            ),
          );
        } catch {
          /* The desktop may have acted. Do not submit it again. */
        }
        this.options.store.put("shared_mac_delivery", {
          id: command.id,
          fingerprint,
          state: result.ok ? "finished" : "unknown",
        });
      }
      await post("/device/result", {
        connectionId: connection.id,
        id: command.id,
        result,
      });
    };
    try {
      while (!combined.aborted) {
        const input = z
          .object({ command: sharedCommandSchema.nullable() })
          .strict()
          .parse(await post("/device/poll", { connectionId: connection.id }));
        if (!input.command) continue;
        if (active.size >= 32) throw Error("shared_local_capacity");
        // Renew/Stop must not wait behind a slow language model request.
        const task = execute(input.command).catch(() => {
          stop.abort();
        });
        active.add(task);
        void task.finally(() => active.delete(task));
      }
    } finally {
      stop.abort();
      clearInterval(timer);
      await Promise.allSettled(
        [...calls].map((callId) => this.options.closeCall(callId)),
      );
      await Promise.allSettled(active);
    }
  }
}
