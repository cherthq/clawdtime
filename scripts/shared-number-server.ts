import { serve } from "@hono/node-server";
import { z } from "zod";
import { isAbsolute, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  readPrivateJSON,
  privateFolder,
} from "../connectors/shared/private-file.js";
import { Store } from "../src/storage/store.js";
import { createSharedNumberApp } from "../src/shared-number-app.js";
import { sharedVerificationText } from "../src/transport/shared-verification-text.js";
import { SharedProvider } from "../src/control/shared-provider.js";
import { SharedProviderAPI } from "../src/transport/shared-provider-api.js";

const schema = z
  .object({
    enabled: z.boolean(),
    database: z.string().refine(isAbsolute),
    lineId: z.uuid(),
    /** Numbers that may get a sign-in text before they are members. */
    invited: z
      .array(z.string().regex(/^\+[1-9]\d{6,14}$/))
      .max(1000)
      .default([]),
    proofKey: z.string().regex(/^[a-f0-9]{64}$/i),
    identityKey: z.string().regex(/^[a-f0-9]{64}$/i),
    lineToken: z.string().min(32),
    host: z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1"),
    /** True only when every request comes through a proxy on this host that
     * appends the client address to X-Forwarded-For. */
    behindProxy: z.boolean().default(false),
    port: z.number().int().min(1024).max(65535).default(3318),
    provider: z
      .object({
        integrationId: z.uuid(),
        endpoint: z.url(),
        webhookSecret: z.string().min(32),
        controlCredentialsFile: z.string().refine(isAbsolute),
        media: z
          .object({
            url: z.url().refine((value) => {
              const url = new URL(value);
              return url.protocol === "wss:" && !url.username && !url.password;
            }),
            key: z.string().min(1),
            secret: z.string().min(16),
            agentName: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
          })
          .strict(),
      })
      .strict()
      .optional(),
    messaging: z
      .object({
        origin: z.url(),
        projectId: z.uuid(),
        key: z.string().min(32),
      })
      .strict(),
  })
  .strict()
  .refine(
    (config) => !config.enabled || !!config.provider,
    "enabled_provider_required",
  )
  .refine(
    (config) =>
      config.proofKey.toLowerCase() !== config.identityKey.toLowerCase(),
    "separate_keys_required",
  );
/** A module of the voice worker in `line/`, from the compiled entry in
 * `dist/scripts/` or from this source file in `scripts/`. */
const lineModule = (name: string) => {
  const here = new URL(".", import.meta.url);
  const root = here.pathname.endsWith("/dist/scripts/") ? "../../" : "../";
  return new URL(`${root}line/${name}`, here).href;
};
/** A lock without an owner file this old was left by a crash between the
 * two steps that make it. A younger one may belong to a starting owner. */
const ownerlessLockMs = 60_000;

/** The process that wrote the owner file has ended, or an ownerless lock is
 * old. Any doubt keeps the lock, so two coordinators never share one store. */
function ownerEnded(lock: string) {
  let owner: unknown;
  try {
    owner = JSON.parse(readFileSync(`${lock}/owner.json`, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    return Date.now() - statSync(lock).mtimeMs > ownerlessLockMs;
  }
  const pid = z.object({ pid: z.number().int().positive() }).safeParse(owner);
  if (!pid.success || pid.data.pid === process.pid) return false;
  try {
    process.kill(pid.data.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Moves an ended owner's lock aside and removes it. The lock is moved first
 * and checked again, so a lock that another starting coordinator made in the
 * meantime is put back untouched. */
function takeOverEndedOwner(lock: string) {
  try {
    if (!ownerEnded(lock)) return;
    const aside = `${lock}.ended-${process.pid}-${randomBytes(6).toString("hex")}`;
    renameSync(lock, aside);
    if (!ownerEnded(aside)) {
      renameSync(aside, lock);
      return;
    }
    rmSync(aside, { recursive: true, force: true });
    console.error("Shared coordinator took over the lock of an ended owner.");
  } catch {
    // The second attempt to make the lock decides.
  }
}

async function main() {
  const path = process.env.CLAWDTIME_SHARED_CONFIG;
  if (!path || !isAbsolute(path)) throw Error("shared_config_required");
  const loaded = readPrivateJSON(path);
  if (loaded.problem) throw Error("shared_config_refused");
  const config = schema.parse(loaded.value);
  privateFolder(dirname(config.database));
  const lock = `${config.database}.owner`;
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    takeOverEndedOwner(lock);
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch {
      throw Error("shared_coordinator_owner_unresolved");
    }
  }
  writeFileSync(
    `${lock}/owner.json`,
    JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
    { mode: 0o600, flag: "wx" },
  );
  const store = new Store(config.database);
  try {
    const service = createSharedNumberApp({
      store,
      ...config,
      callbacksEnabled: !!config.provider,
      sendCode: sharedVerificationText({
        ...config.messaging,
        lineId: config.lineId,
      }),
    });
    let provider: SharedProvider | undefined;
    if (config.provider) {
      const { sharedMedia } = await import(lineModule("shared-media.mjs"));
      const { transportReadiness } = await import(
        lineModule("local-readiness.mjs")
      );
      const api = new SharedProviderAPI({
        callsOrigin: config.messaging.origin,
        projectId: config.messaging.projectId,
        projectKey: config.messaging.key,
        lineId: config.lineId,
        integrationId: config.provider.integrationId,
        endpoint: config.provider.endpoint,
        transportReady: transportReadiness,
        controlToken: () => {
          const saved = readPrivateJSON(
            config.provider!.controlCredentialsFile,
          );
          if (saved.problem)
            throw Error("shared_control_credential_unavailable");
          const token = z
            .object({
              access_token: z.string().min(16),
              expires_at: z.number().gt(Date.now()),
            })
            .parse(saved.value);
          return token.access_token;
        },
      });
      provider = new SharedProvider({
        store,
        router: service.router,
        lineId: config.lineId,
        webhookSecret: config.provider.webhookSecret,
        media: sharedMedia(config.provider.media),
        api,
        event: service.providerEvent,
      });
      service.app.post("/provider/webhook", async (c) => {
        const raw = await c.req.text();
        if (Buffer.byteLength(raw) > 32768) return c.json({ ok: false }, 413);
        return c.json(
          await provider!.webhook(raw, c.req.header("x-chert-signature") ?? ""),
        );
      });
    }
    let pumping: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (config.enabled && provider && !pumping)
        pumping = provider
          .pump()
          .catch(() => {
            console.error("Shared provider reconciliation deferred.");
          })
          .finally(() => {
            pumping = undefined;
          });
    }, 1000);
    timer.unref();
    const server = serve(
      {
        hostname: config.host,
        port: config.port,
        // The second argument carries the socket, which sign-in limits read.
        fetch: (request, connection) =>
          new URL(request.url).pathname === "/health"
            ? Response.json(
                {
                  service: "shared-number",
                  mode: config.enabled ? "enabled" : "standby",
                  providerConfigured: !!provider,
                  physicalAcceptance: false,
                },
                { headers: { "Cache-Control": "no-store" } },
              )
            : !config.enabled
              ? new Response(
                  JSON.stringify({ ok: false, code: "shared_standby" }),
                  { status: 503 },
                )
              : service.app.fetch(request, connection),
      },
      () =>
        console.log(
          `Shared coordinator ${config.enabled ? "available" : "standby"}; provider ${provider ? "configured" : "not configured"}.`,
        ),
    );
    const close = () => {
      clearInterval(timer);
      service.close();
      server.close(async () => {
        await pumping;
        await provider?.drain();
        store.close();
        rmSync(lock, { recursive: true });
      });
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  } catch (error) {
    store.close();
    rmSync(lock, { recursive: true });
    throw error;
  }
}
void main().catch(() => {
  console.error(
    "Shared coordinator refused startup. Check its protected configuration.",
  );
  process.exitCode = 1;
});
