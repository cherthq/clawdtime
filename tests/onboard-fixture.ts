import { serve } from "@hono/node-server";
import { createSharedNumberApp } from "../src/shared-number-app.js";
import { Store } from "../src/storage/store.js";

// Made-up numbers only.
export const member = "+14155550100";
export const lineToken = "test-line-token-".repeat(4);

/** A coordinator on 127.0.0.1: the real routes in memory, and a health
 * answer that a test chooses, as the coordinator's own server answers it.
 * The texts stay in this process: nothing leaves it. */
export async function fakeCoordinator(
  options: {
    health?: Record<string, unknown> | null;
    now?: () => number;
    invited?: string[];
  } = {},
) {
  const store = new Store();
  const texts: { recipient: string; code: string }[] = [];
  const service = createSharedNumberApp({
    store,
    lineId: "line",
    proofKey: "aa".repeat(32),
    identityKey: "bb".repeat(32),
    lineToken,
    invited: options.invited ?? [member],
    ...(options.now ? { now: options.now } : {}),
    sendCode: async (recipient, code) => {
      texts.push({ recipient, code });
      return true;
    },
  });
  const health =
    options.health === undefined
      ? {
          service: "shared-number",
          protocol: 1,
          mode: "enabled",
          providerConfigured: true,
          physicalAcceptance: false,
        }
      : options.health;
  const paths: string[] = [];
  const server = serve({
    fetch: (request, connection) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === "/health")
        return health
          ? Response.json(health)
          : new Response("unavailable", { status: 503 });
      return service.app.fetch(request, connection);
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  await new Promise<void>((resolve) =>
    server.listening ? resolve() : server.once("listening", resolve),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw Error("address");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    texts,
    paths,
    store,
    codeFor: (recipient: string) =>
      texts.filter((text) => text.recipient === recipient).at(-1)?.code,
    close: () =>
      new Promise<void>((resolve) => {
        service.close();
        server.close(() => {
          store.close();
          resolve();
        });
        if ("closeAllConnections" in server) server.closeAllConnections();
      }),
  };
}
