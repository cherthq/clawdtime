import { Hono } from "hono";
import { token } from "../storage/security.js";

/** Temporary local safety control for c.1; no task creation or call admission. */
export function createTaskAudioStopApp(options: {
  origin: string;
  stop: () => Promise<void>;
  status: () => { state: string; ended: boolean };
}) {
  const secret = token(),
    host = new URL(options.origin).host;
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (
      c.req.header("host") !== host ||
      (c.req.header("origin") && c.req.header("origin") !== options.origin)
    )
      return c.text("Forbidden", 403);
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.get("/", (c) => {
    c.header(
      "Set-Cookie",
      `clawdtime_stop=${secret}; HttpOnly; SameSite=Strict; Path=/`,
    );
    return c.html(
      `<!doctype html><meta name="viewport" content="width=device-width"><title>ClawdTime voice test</title><style>body{font:20px system-ui;max-width:620px;margin:70px auto;padding:24px}button{font:inherit;padding:16px 32px;background:#b21f38;color:white;border:0;border-radius:8px}</style><h1>ClawdTime voice test</h1><p>One audio-only call. You can stop it here or hang up on your handset.</p><p id="state">Preparing</p><button id="stop">Stop call</button><script>const button=document.getElementById('stop'),state=document.getElementById('state');button.onclick=async()=>{button.disabled=true;try{const r=await fetch('/stop',{method:'POST'});if(!r.ok)throw Error();state.textContent='Stopping call'}catch{state.textContent='Stop is unconfirmed. Hang up on your handset.';button.disabled=false}};setInterval(async()=>{try{const r=await fetch('/status');state.textContent=(await r.json()).state}catch{}},1000)</script>`,
    );
  });
  app.get("/status", (c) => c.json(options.status()));
  app.post("/stop", async (c) => {
    const values = (c.req.header("cookie") ?? "")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("clawdtime_stop="));
    if (
      c.req.header("origin") !== options.origin ||
      values.length !== 1 ||
      values[0] !== `clawdtime_stop=${secret}`
    )
      return c.text("Forbidden", 403);
    await options.stop();
    return c.json({ stopping: true });
  });
  return app;
}
