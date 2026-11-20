import type { CliFact } from "./inventory.js";
import { detailLabels, elapsed, summary, title, where } from "./render.js";
import type { TroveEntry, TroveNote, TroveRule } from "./trove.js";
import type { BoardSnapshot } from "./types.js";

export interface ReportData {
  now: number;
  board: BoardSnapshot;
  clis: CliFact[];
  decisions: TroveEntry[];
  rules: TroveRule[];
  notes: TroveNote[];
  /** What the person can do next, one sentence each. */
  next: string[];
}

/** Every value in the deck comes from other programs: it is text, never markup. */
const escape = (value: string) =>
  value
    .replace(/\p{C}/gu, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
const day = (time: number) => new Date(time).toISOString().slice(0, 10);

/** One sentence that says the most urgent thing, as the board's headline does. */
export function headline(board: BoardSnapshot) {
  const { needs_you: waiting, working } = board.counts;
  if (waiting)
    return waiting === 1 ? "1 agent needs you" : `${waiting} agents need you`;
  if (working)
    return working === 1 ? "1 agent at work" : `${working} agents at work`;
  return board.sessions.length ? "All quiet" : "No agents are running";
}

const css = `
:root{--canvas:#f7f5ef;--surface:#fffdf8;--label:#1c1a16;--second:#615b4f;--border:#e3ddd1;--fill:#efebe2;--accent:#ff8040;--accent-text:#ad4510;--warning:#94490a;--warning-tint:#fdf1d9;--info:#3a4686;--info-tint:#ebedf7;--success:#1d7444;--danger:#bf2a22}
@media (prefers-color-scheme:dark){:root{--canvas:#141210;--surface:#1c1916;--label:#f4efe6;--second:#b2a999;--border:#2e2a25;--fill:#2b2723;--accent:#ff8a50;--accent-text:#ffa577;--warning:#efc15a;--warning-tint:#30270f;--info:#a6b4f2;--info-tint:#1c2136;--success:#58c785;--danger:#f2766f}}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{background:var(--canvas);color:var(--label);font-family:"Instrument Sans",-apple-system,"Helvetica Neue",Arial,sans-serif;font-size:18px;line-height:1.45;overflow:hidden}
.slide{position:absolute;inset:0;display:none;flex-direction:column;gap:28px;padding:7vh 8vw 9vh}
.slide.on{display:flex}
h1{margin:0;font-family:Fraunces,ui-serif,Georgia,serif;font-weight:600;font-size:clamp(34px,5.2vw,64px);line-height:1.08;letter-spacing:-0.02em}
h2{margin:0;font-family:Fraunces,ui-serif,Georgia,serif;font-weight:600;font-size:clamp(26px,3.2vw,40px);line-height:1.15;letter-spacing:-0.01em}
.eyebrow{font-family:"JetBrains Mono","SF Mono",ui-monospace,Menlo,monospace;font-size:14px;color:var(--second)}
p{margin:0;color:var(--second);max-width:60ch}
table{border-collapse:collapse;width:100%;font-size:16px}
th{font-size:13px;font-weight:600;color:var(--second);text-align:left;padding:8px 14px 8px 0;border-bottom:1px solid var(--border)}
td{padding:11px 14px 11px 0;border-bottom:1px solid var(--border);vertical-align:middle}
td.num,th.num{text-align:right;font-family:"JetBrains Mono","SF Mono",ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums}
.mono{font-family:"JetBrains Mono","SF Mono",ui-monospace,Menlo,monospace;font-size:14px}
.pill{display:inline-block;padding:3px 11px;border-radius:999px;font-size:12px;font-weight:600;background:var(--fill);color:var(--second)}
.pill.wait{background:var(--warning-tint);color:var(--warning)}.pill.work{background:var(--info-tint);color:var(--info)}
.bar{height:8px;border-radius:999px;background:var(--fill);min-width:120px}.bar i{display:block;height:100%;border-radius:999px;background:var(--accent)}
.figures{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px}
.figure{background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:20px}
.figure b{display:block;font-family:"JetBrains Mono","SF Mono",ui-monospace,Menlo,monospace;font-size:34px;font-weight:500;letter-spacing:-0.02em}
.figure span{font-size:14px;color:var(--second)}
ul{margin:0;padding-left:1.1em;display:flex;flex-direction:column;gap:12px}li{max-width:70ch}
.foot{position:fixed;left:8vw;right:8vw;bottom:3.2vh;display:flex;justify-content:space-between;font-family:"JetBrains Mono","SF Mono",ui-monospace,Menlo,monospace;font-size:13px;color:var(--second)}
.scroll{overflow:auto;min-height:0}
@media print{body{overflow:visible}.slide{position:static;display:flex;min-height:100vh;page-break-after:always}.foot{display:none}}
`;

const script = `
const slides=[...document.querySelectorAll('.slide')];let at=0;
function show(n){at=Math.max(0,Math.min(slides.length-1,n));slides.forEach((s,i)=>s.classList.toggle('on',i===at));document.getElementById('where').textContent=(at+1)+' / '+slides.length;}
addEventListener('keydown',e=>{if(['ArrowRight','ArrowDown','PageDown',' '].includes(e.key))show(at+1);if(['ArrowLeft','ArrowUp','PageUp'].includes(e.key))show(at-1);if(e.key==='Home')show(0);if(e.key==='End')show(slides.length-1);});
addEventListener('click',e=>{if(e.target.closest('a'))return;show(e.clientX>innerWidth/2?at+1:at-1);});show(0);
`;

/** The supervisor's report as a slide deck: one file, no network, arrow keys to move. */
export function renderDeck(data: ReportData) {
  const { board, clis, decisions, rules, notes } = data;
  const most = Math.max(1, ...clis.map((cli) => cli.sessionsLast7Days ?? 0));
  const allowed = decisions.filter(
    (entry) => entry.decision === "allow",
  ).length;
  const denied = decisions.filter((entry) => entry.decision === "deny").length;
  const answered = decisions.filter(
    (entry) => entry.decision === "answer",
  ).length;
  const byRule = decisions.filter((entry) => entry.via === "playbook").length;
  const byCall = decisions.filter((entry) => entry.via === "call").length;
  const slides: string[] = [];
  slides.push(`<div class="eyebrow">ClawdTime report · ${day(data.now)}</div>
<h1>${escape(headline(board))}</h1>
<p>${escape(summary(board.counts))}. This deck is what ClawdTime sees on this Mac: the agent sessions, the agent commands and their use, and the decisions it keeps.</p>
<div class="figures"><div class="figure"><b>${board.sessions.length}</b><span>agent sessions now</span></div><div class="figure"><b>${board.counts.needs_you}</b><span>wait for you</span></div><div class="figure"><b>${clis.filter((cli) => cli.installed).length}</b><span>agent commands installed</span></div><div class="figure"><b>${decisions.length}</b><span>decisions in the trove</span></div></div>`);
  slides.push(`<div class="eyebrow">Now</div><h2>Every session, most urgent first</h2>
<div class="scroll"><table><thead><tr><th>State</th><th>Session</th><th>Agent</th><th>Doing</th><th class="num">For</th><th>Where</th></tr></thead><tbody>${
    board.sessions
      .slice(0, 40)
      .map(
        (session) =>
          `<tr><td><span class="pill ${session.state === "needs_you" ? "wait" : session.state === "working" ? "work" : ""}">${escape(session.state.replace("_", " "))}</span></td><td>${escape(title(session))}</td><td>${escape(session.agentLabel)}</td><td>${escape(detailLabels[session.detail])}</td><td class="num">${escape(elapsed(session.since, data.now))}</td><td class="mono">${escape(where(session))}</td></tr>`,
      )
      .join("") || `<tr><td colspan="6">No agent session is running.</td></tr>`
  }</tbody></table></div>`);
  slides.push(`<div class="eyebrow">Agent commands on this Mac</div><h2>What is installed, and how much it is used</h2>
<div class="scroll"><table><thead><tr><th>Agent</th><th>Version</th><th class="num">Running</th><th class="num">Sessions, 7 days</th><th></th><th class="num">All</th><th>Last used</th></tr></thead><tbody>${
    clis
      .map(
        (cli) =>
          `<tr><td>${escape(cli.label)}${cli.installed ? "" : ' <span class="pill">not on PATH</span>'}</td><td class="mono">${escape(cli.version ?? "")}</td><td class="num">${cli.runningNow}</td><td class="num">${cli.sessionsLast7Days ?? ""}</td><td><div class="bar"><i style="width:${Math.round(((cli.sessionsLast7Days ?? 0) / most) * 100)}%"></i></div></td><td class="num">${cli.sessions ?? ""}</td><td class="mono">${cli.lastUsedAt ? day(cli.lastUsedAt) : ""}</td></tr>`,
      )
      .join("") || `<tr><td colspan="7">No agent command was found.</td></tr>`
  }</tbody></table></div>`);
  slides.push(`<div class="eyebrow">Trove</div><h2>Decisions that ClawdTime remembers</h2>
<div class="figures"><div class="figure"><b>${allowed}</b><span>allowed</span></div><div class="figure"><b>${denied}</b><span>denied</span></div><div class="figure"><b>${answered}</b><span>questions answered</span></div><div class="figure"><b>${byRule} · ${byCall}</b><span>by a standing rule · on a call</span></div></div>
<div class="scroll"><table><thead><tr><th>Day</th><th>Project</th><th>Agent</th><th>Request</th><th>Answer</th><th>Through</th></tr></thead><tbody>${
    [...decisions]
      .reverse()
      .slice(0, 12)
      .map(
        (entry) =>
          `<tr><td class="mono">${day(entry.at)}</td><td>${escape(entry.project)}</td><td>${escape(entry.agent)}</td><td class="mono">${escape(entry.summary.slice(0, 80))}</td><td>${escape(entry.decision)}${entry.text ? `: ${escape(entry.text.slice(0, 60))}` : ""}</td><td>${escape(entry.via)}</td></tr>`,
      )
      .join("") || `<tr><td colspan="6">No decision is recorded yet.</td></tr>`
  }</tbody></table></div>`);
  slides.push(`<div class="eyebrow">Playbook</div><h2>Critical decisions and standing rules</h2>
<ul>${
    [...notes]
      .reverse()
      .slice(0, 8)
      .map(
        (note) =>
          `<li><span class="mono">${day(note.at)}</span> ${escape(note.text)}</li>`,
      )
      .join("") || "<li>No critical decision is recorded yet.</li>"
  }</ul>
<ul>${
    rules
      .slice(0, 8)
      .map(
        (rule) =>
          `<li>Allow <span class="mono">${escape(rule.pattern)}</span> for ${escape(rule.agent)} in <span class="mono">${escape(rule.cwd)}</span></li>`,
      )
      .join("") || "<li>No standing rule. A person answers every request.</li>"
  }</ul>`);
  slides.push(`<div class="eyebrow">Next</div><h2>What to do now</h2>
<ul>${data.next.map((item) => `<li>${escape(item)}</li>`).join("") || "<li>Nothing waits for you.</li>"}</ul>`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ClawdTime report ${day(data.now)}</title><style>${css}</style></head>
<body>${slides.map((slide) => `<section class="slide">${slide}</section>`).join("\n")}
<div class="foot"><span>ClawdTime · ${day(data.now)}</span><span id="where"></span></div>
<script>${script}</script></body></html>
`;
}
