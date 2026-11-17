import { randomBytes, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { productionNativeReferenceSchema } from "../../src/production-native-contracts.js";
import type { ProductionWalkthroughController } from "./production-native.js";

/** One loopback-only fixed-operation button for the original chat's permitted CUA. */
export async function startProductionNativeTrigger(
  controller: ProductionWalkthroughController,
) {
  const token = randomBytes(32).toString("hex");
  const app = new Hono();
  let origin = "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>ClawdTime prepared walkthrough</title></head><body>
<h1>Prepared walkthrough</h1><p id="state">Connecting…</p><button id="execute" disabled>Execute prepared operation</button><button id="stop">Stop walkthrough</button>
<script>
const token=location.hash.slice(1);history.replaceState(null,"",location.pathname);
const state=document.getElementById("state"),button=document.getElementById("execute");let prepared=null,busy=false;
async function api(path,body){const r=await fetch(path,{method:body===undefined?"GET":"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)}),cache:"no-store",redirect:"error"});if(!r.ok)throw new Error("Inspect the original receipt; no automatic retry.");return r.json()}
async function status(){if(busy)return;try{const s=await api("/status");prepared=s.prepared;button.disabled=s.stopped||s.busy||s.dispatchAttempted||!prepared||s.receipt?.phase!=="prepared";state.textContent=s.stopped?"Stopped. Use companion Stop to end capture and input.":prepared?prepared.operation.action+" — "+prepared.operation.window.appId+" — "+(s.receipt?.phase||"pending"):s.scene.phase;}catch(e){button.disabled=true;state.textContent=e.message}}
button.onclick=async()=>{if(!prepared||busy)return;busy=true;button.disabled=true;try{await api("/execute",{operationId:prepared.operation.operationId,fingerprint:prepared.fingerprint});state.textContent="Verified operation; inspect the presented result."}catch(e){state.textContent=e.message}finally{busy=false;await status()}};
document.getElementById("stop").onclick=async()=>{button.disabled=true;try{await api("/stop",{});state.textContent="Stopped. Use companion Stop to end capture and input."}catch(e){state.textContent=e.message}};
status();setInterval(status,1000);
</script></body></html>`;
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    if (new URL(c.req.url).origin !== origin)
      return c.json({ error: "wrong_origin" }, 403);
    if (c.req.path === "/" && c.req.method === "GET") return next();
    const actual = Buffer.from(c.req.header("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return c.json({ error: "unauthorized" }, 401);
    if (c.req.header("origin") && c.req.header("origin") !== origin)
      return c.json({ error: "wrong_origin" }, 403);
    await next();
  });
  app.use("*", bodyLimit({ maxSize: 1024 }));
  app.get("/", (c) => c.html(html));
  app.get("/status", (c) => c.json(controller.status()));
  app.post("/execute", async (c) => {
    try {
      const reference = productionNativeReferenceSchema.parse(
        await c.req.json(),
      );
      return c.json(await controller.executePrepared(reference));
    } catch {
      return c.json({ error: "inspect_original_receipt" }, 409);
    }
  });
  app.post("/stop", (c) => {
    controller.stop();
    return c.json({ stopped: true });
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    if (server.listening) resolve();
    else {
      server.once("listening", resolve);
      server.once("error", reject);
    }
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Loopback trigger did not bind.");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/#${token}`,
    close: async () => {
      controller.stop();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
