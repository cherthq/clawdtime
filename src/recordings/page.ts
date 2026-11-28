/**
 * The admin page of the call recordings: one HTML shell with no data in it,
 * one style sheet and one script, all from this service. The script reads the
 * calls from the admin API of the same address after sign-in. It puts every
 * value of a call into the page as text, never as markup.
 */
export const pageHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Call recordings</title>
<link rel="stylesheet" href="/admin/recordings/app.css">
<script src="/admin/recordings/app.js" defer></script>
</head>
<body>
<header class="bar">
  <div class="brand"><span class="stone" aria-hidden="true"></span><span>ClawdTime</span></div>
  <h1>Call recordings</h1>
  <p class="note">Internal. For admins only.</p>
  <button id="signout" class="quiet" type="button" hidden>Sign out</button>
</header>
<main>
  <section id="off" class="panel" hidden>
    <h2>The admin page is off</h2>
    <p>To turn it on, run this command on this Mac:</p>
    <pre>clawdtime recordings admin</pre>
  </section>
  <section id="signin" class="panel" hidden>
    <h2>Sign in</h2>
    <p>Type the admin token. To see where it is, run <code>clawdtime recordings admin</code> on this Mac.</p>
    <form id="signin-form">
      <label for="token">Admin token</label>
      <input id="token" name="token" type="password" autocomplete="off" spellcheck="false" required>
      <button type="submit">Sign in</button>
      <p id="signin-error" class="error" role="alert"></p>
    </form>
  </section>
  <div id="app" class="split" hidden>
    <section class="panel list" aria-labelledby="calls-title">
      <div class="head">
        <h2 id="calls-title">Calls</h2>
        <span id="count" class="muted"></span>
      </div>
      <p id="empty" class="muted" hidden>No recorded calls. A call is recorded only on a line with recording on.</p>
      <table id="calls">
        <thead><tr><th scope="col">Time</th><th scope="col">Line</th><th scope="col">Duration</th><th scope="col">Recorded</th></tr></thead>
        <tbody></tbody>
      </table>
    </section>
    <section id="detail" class="panel detail" aria-live="polite">
      <p class="muted">Select a call to see its transcript and files.</p>
    </section>
  </div>
</main>
</body>
</html>
`;

export const pageCss = `:root {
  --paper: #f4f1e8; --card: #fffdf7; --ink: #252c27; --muted: #676e65;
  --line: #d1d1c2; --green: #366a43; --mint: #c8e6bb; --warn: #8a4b14; --warn-bg: #f6e3cf;
  --select: #e7efe0; color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: #161a17; --card: #1e231f; --ink: #e8ece6; --muted: #9ea69b;
    --line: #333a34; --green: #8fc79b; --mint: #2c4a33; --warn: #f0b27a; --warn-bg: #3d2a19;
    --select: #26332a; color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --paper: #161a17; --card: #1e231f; --ink: #e8ece6; --muted: #9ea69b;
  --line: #333a34; --green: #8fc79b; --mint: #2c4a33; --warn: #f0b27a; --warn-bg: #3d2a19;
  --select: #26332a; color-scheme: dark;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: var(--paper); color: var(--ink);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; }
.bar { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap;
  padding: 16px 24px; border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.stone { width: 14px; height: 14px; border-radius: 50% 45% 50% 40%; background: var(--green); display: inline-block; }
h1 { font-size: 18px; margin: 0; font-weight: 600; }
h2 { font-size: 16px; margin: 0 0 8px; font-weight: 600; }
h3 { font-size: 13px; margin: 20px 0 8px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.note { margin: 0; color: var(--muted); font-size: 13px; }
#signout { margin-left: auto; }
main { padding: 24px; max-width: 1280px; margin: 0 auto; }
.panel { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 20px; min-width: 0; }
#off, #signin { max-width: 520px; margin: 40px auto; }
.split { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: 20px; align-items: start; }
@media (max-width: 860px) { .split { grid-template-columns: minmax(0, 1fr); } main { padding: 16px; } .bar { padding: 16px; } }
.head { display: flex; align-items: baseline; justify-content: space-between; }
.muted { color: var(--muted); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; font-weight: 600; color: var(--muted); font-size: 12px; padding: 8px; border-bottom: 1px solid var(--line); }
.nowrap { white-space: nowrap; }
@media (max-width: 600px) {
  #calls thead { display: none; }
  #calls tr { display: grid; grid-template-columns: auto auto minmax(0, 1fr); column-gap: 12px; border-bottom: 1px solid var(--line); padding: 6px 0; }
  #calls td { border: 0; padding: 4px 8px; }
  #calls td:last-child { grid-column: 1 / -1; }
}
td { padding: 10px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
tbody tr { cursor: pointer; }
tbody tr:hover, tbody tr[aria-selected="true"] { background: var(--select); }
tbody tr:focus-visible { outline: 2px solid var(--green); outline-offset: -2px; }
.tag { display: inline-block; font-size: 12px; padding: 1px 8px; border-radius: 999px; background: var(--mint); margin: 0 4px 4px 0; white-space: nowrap; }
.tag.warn { background: var(--warn-bg); color: var(--warn); }
.meta { color: var(--muted); margin: 0 0 4px; }
.players { display: grid; gap: 12px; }
.player label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 4px; }
audio, video { width: 100%; }
video { background: #000; border-radius: 8px; max-height: 360px; }
.files { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
.files a, a.button { color: var(--green); font-weight: 500; }
a.button { display: inline-block; margin-top: 10px; padding: 7px 14px; border: 1px solid var(--green); border-radius: 8px; text-decoration: none; }
.reasons { margin: 0; padding-left: 18px; }
.turns { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
.turn { display: grid; grid-template-columns: 52px 64px minmax(0, 1fr); gap: 8px; font-size: 14px; }
.turn .at { color: var(--muted); font-variant-numeric: tabular-nums; }
.turn .who { font-weight: 600; }
.turn.note { color: var(--muted); font-style: italic; }
.turn.note .who { font-weight: 400; }
label { display: block; font-size: 13px; margin: 12px 0 4px; }
input { width: 100%; padding: 9px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper); color: var(--ink); font: inherit; }
button { margin-top: 12px; padding: 8px 16px; border-radius: 8px; border: 1px solid var(--green); background: var(--green); color: var(--card); font: inherit; font-weight: 600; cursor: pointer; }
button.quiet { margin-top: 0; background: transparent; color: var(--green); }
pre, code { font-family: ui-monospace, Menlo, monospace; font-size: 13px; }
pre { background: var(--paper); border: 1px solid var(--line); border-radius: 8px; padding: 10px; overflow-x: auto; }
.error { color: var(--warn); min-height: 1.5em; margin: 8px 0 0; }
`;

export const pageJs = `"use strict";
const base = "/admin/recordings";
const $ = (id) => document.getElementById(id);
const el = (tag, options = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) if (child) node.append(child);
  return node;
};
const when = (iso) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "not known" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(at);
};
const short = (iso) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "not known" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(at);
};
const day = (iso) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "not known" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(at);
};
const duration = (ms) => {
  if (typeof ms !== "number") return "not known";
  const seconds = Math.round(ms / 1000), minutes = Math.floor(seconds / 60);
  return minutes ? minutes + " min " + String(seconds % 60).padStart(2, "0") + " s" : seconds + " s";
};
const clock = (ms) => {
  const seconds = Math.floor(ms / 1000);
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
};
const size = (bytes) => bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(bytes / 1024)) + " KB";
const names = { "transcript": "Transcript", "caller-audio": "Caller audio", "agent-audio": "Agent audio", "mixed-audio": "Both sides", "video": "Caller video" };
const who = { caller: "Caller", agent: "Agent", note: "Note" };
const file = (id, name, download) => base + "/api/calls/" + encodeURIComponent(id) + "/files/" + encodeURIComponent(name) + (download ? "?download=1" : "");

async function api(path) {
  const response = await fetch(base + path, { credentials: "same-origin", headers: { accept: "application/json" } });
  if (response.status === 401) { show("signin"); throw new Error("signin"); }
  if (response.status === 403) { show("off"); throw new Error("off"); }
  if (!response.ok) throw new Error("failed");
  return response.json();
}
function show(view) {
  $("off").hidden = view !== "off";
  $("signin").hidden = view !== "signin";
  $("app").hidden = view !== "app";
  $("signout").hidden = view !== "app";
}
function tags(call) {
  const out = [];
  for (const kind of new Set(call.parts.map((part) => part.part))) if (kind !== "transcript") out.push(el("span", { class: "tag", text: names[kind] }));
  if (call.stoppedBy === "caller") out.push(el("span", { class: "tag warn", text: "Stopped by the caller" }));
  if (call.status === "recording") out.push(el("span", { class: "tag warn", text: "Call goes on" }));
  if (call.status === "incomplete") out.push(el("span", { class: "tag warn", text: "Not finished" }));
  return out;
}
let selected = null;
async function load() {
  const { calls } = await api("/api/calls");
  show("app");
  const body = $("calls").querySelector("tbody");
  body.replaceChildren();
  $("count").textContent = calls.length === 1 ? "1 call" : calls.length + " calls";
  $("empty").hidden = calls.length > 0;
  $("calls").hidden = calls.length === 0;
  for (const call of calls) {
    const row = el("tr", { tabindex: "0", "data-id": call.id },
      el("td", { class: "nowrap", text: short(call.callStartedAt) }),
      el("td", { class: "nowrap", text: call.line }),
      el("td", { class: "nowrap", text: duration(call.durationMs) }),
      el("td", {}, ...tags(call)));
    row.addEventListener("click", () => open(call.id));
    row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(call.id); } });
    body.append(row);
  }
  const first = selected && calls.some((call) => call.id === selected) ? selected : calls[0]?.id;
  if (first) await open(first);
}
async function open(id) {
  selected = id;
  for (const row of $("calls").querySelectorAll("tbody tr")) row.setAttribute("aria-selected", String(row.dataset.id === id));
  const { call, transcript } = await api("/api/calls/" + encodeURIComponent(id));
  const detail = $("detail");
  const players = el("div", { class: "players" });
  for (const part of call.parts.filter((p) => p.part.endsWith("audio")).sort((a, b) => (a.part === "mixed-audio" ? -1 : b.part === "mixed-audio" ? 1 : 0))) {
    players.append(el("div", { class: "player" }, el("label", { text: names[part.part] }), el("audio", { controls: "", preload: "metadata", src: file(id, part.file) })));
  }
  const videos = call.parts.filter((p) => p.part === "video");
  const videoBox = el("div", { class: "players" });
  videos.forEach((part, index) => videoBox.append(el("div", { class: "player" }, el("label", { text: videos.length > 1 ? names.video + " " + (index + 1) : names.video }), el("video", { controls: "", preload: "metadata", src: file(id, part.file) }))));
  const files = el("ul", { class: "files" });
  for (const part of call.parts) files.append(el("li", {}, el("a", { href: file(id, part.file, true), download: "" , text: names[part.part] + (part.part === "video" && videos.length > 1 ? " " + part.file.replace(/\\D/g, "") : "") }), document.createTextNode(" " + part.file + ", " + size(part.bytes || 0))));
  const missing = call.missing.length ? el("ul", { class: "reasons" }, ...call.missing.map((item) => el("li", { text: item.reason }))) : null;
  const turns = el("ol", { class: "turns" });
  for (const turn of transcript) turns.append(el("li", { class: "turn " + turn.who }, el("span", { class: "at", text: clock(turn.offsetMs) }), el("span", { class: "who", text: who[turn.who] }), el("span", { text: turn.text + (turn.interrupted ? " (cut off)" : "") })));
  detail.replaceChildren(...[
    el("h2", { text: "Call on " + when(call.callStartedAt) }),
    el("p", { class: "meta", text: "Line " + call.line + ". Duration " + duration(call.durationMs) + ". Recorded " + duration(call.recordedMs) + "." }),
    el("p", { class: "meta", text: "Kept until " + day(call.keepUntil) + "." }),
    el("div", {}, ...tags(call)),
    el("h3", { text: "Audio" }), players.childElementCount ? players : el("p", { class: "muted", text: "No audio for this call." }),
    videos.length ? el("h3", { text: "Video" }) : null, videos.length ? videoBox : null,
    missing ? el("h3", { text: "Not recorded" }) : null, missing,
    el("h3", { text: "Downloads" }), files,
    el("a", { class: "button", href: base + "/api/calls/" + encodeURIComponent(id) + "/zip", download: "", text: "Download all as zip" }),
    el("h3", { text: "Transcript" }), transcript.length ? turns : el("p", { class: "muted", text: "No words in the transcript." }),
  ].filter(Boolean));
}
async function signIn(token) {
  const response = await fetch(base + "/session", { credentials: "same-origin", headers: { authorization: "Bearer " + token } });
  if (response.status === 403) { show("off"); return false; }
  return response.ok;
}
async function start() {
  const match = /^#token=([A-Za-z0-9_-]{32,200})$/.exec(location.hash);
  if (match) {
    history.replaceState(null, "", location.pathname);
    await signIn(match[1]);
  }
  try { await load(); } catch {}
}
$("signin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = $("token").value.trim();
  $("token").value = "";
  if (await signIn(token)) { $("signin-error").textContent = ""; try { await load(); } catch {} }
  else if ($("off").hidden) $("signin-error").textContent = "The token is not right. Try again.";
});
$("signout").addEventListener("click", async () => {
  await fetch(base + "/signout", { credentials: "same-origin" });
  show("signin");
});
start();
`;
