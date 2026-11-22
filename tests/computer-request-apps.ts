/**
 * Small apps that work, for the whole-request test (computer-request.eval.ts).
 *
 * Each one is a page that looks like a Mac app window and behaves like one:
 * a row opens a note, text goes into the editor, a switch turns, a dialog
 * closes. An element that the Accessibility tree of a real app would name
 * carries data-role and data-title. `window.state()` gives what the app holds,
 * for the check at the end of a request. Every name here is invented.
 */

const base = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #2b6ea8; font: 13px -apple-system, "Helvetica Neue", Arial, sans-serif; color: #1d1d1f; }
  .window { position: absolute; left: 90px; top: 50px; width: 1100px; height: 720px; background: #fff; border-radius: 10px;
    box-shadow: 0 20px 60px rgba(0,0,0,.45); overflow: hidden; display: flex; flex-direction: column; }
  .titlebar { height: 44px; background: #ececec; border-bottom: 1px solid #d0d0d0; display: flex; align-items: center; padding: 0 12px; gap: 8px; }
  .light { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
  .title { font-weight: 600; margin-left: 12px; flex: 1; }
  .icon { width: 28px; height: 26px; border: 0; background: transparent; border-radius: 5px; padding: 3px; }
  .icon svg { width: 20px; height: 20px; stroke: #444; fill: none; stroke-width: 1.6; }
  .content { flex: 1; display: flex; min-height: 0; position: relative; }
  button.push { border: 1px solid #c8c8c8; background: #fff; border-radius: 6px; padding: 4px 14px; font: inherit; }
  button.primary { background: #0a7aff; border-color: #0a7aff; color: #fff; }
  .sheet { position: absolute; left: 300px; top: 150px; width: 500px; background: #f4f4f4; border: 1px solid #c4c4c4; border-radius: 12px; padding: 22px; box-shadow: 0 12px 40px rgba(0,0,0,.35); z-index: 5; }
  .sheet h3 { margin: 0 0 6px; } .sheet p { color: #555; margin: 0 0 18px; }
  .buttons { display: flex; gap: 10px; justify-content: flex-end; }
`;
const lights = `<span class="light" style="background:#ff5f57"></span><span class="light" style="background:#febc2e"></span><span class="light" style="background:#28c840"></span>`;
const page = (title: string, style: string, body: string, script: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${base}${style}</style></head><body>${body}<script>${script}</script></body></html>`;

const pencil = `<svg viewBox="0 0 24 24"><path d="M4 20h4l10-10-4-4L4 16z"/><path d="M13 7l4 4"/></svg>`;
const trash = `<svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg>`;

const notes = page(
  "Notes",
  `.sidebar { width: 260px; border-right: 1px solid #ddd; background: #f6f6f6; overflow-y: auto; }
   .row { padding: 10px 14px; border-bottom: 1px solid #e6e6e6; font-weight: 600; }
   .row small { display: block; font-weight: 400; color: #888; margin-top: 3px; }
   .row.chosen { background: #ffe08a; }
   .editor { flex: 1; padding: 22px 28px; font: 15px/1.6 -apple-system, Arial, sans-serif; border: 0; outline: 0; resize: none; }
   .search { width: 190px; height: 26px; border: 1px solid #c8c8c8; border-radius: 6px; padding: 0 8px; font: inherit; }`,
  `<div class="window"><div class="titlebar">${lights}<div class="title">Notes</div>
     <button class="icon" id="new" data-role="AXButton" data-title="New note">${pencil}</button>
     <button class="icon" id="trash" data-role="AXButton" data-title="Delete">${trash}</button>
     <input class="search" id="search" data-role="AXSearchField" data-title="Search" placeholder="Search">
   </div><div class="content"><div class="sidebar" id="list" data-role="AXScrollArea" data-title=""></div>
     <textarea class="editor" id="editor" data-role="AXTextArea" data-title=""></textarea>
     <div class="sheet" id="sheet" hidden><h3 id="ask" data-role="AXStaticText"></h3><p data-role="AXStaticText" data-title="You cannot undo this.">You cannot undo this.</p>
       <div class="buttons"><button class="push" id="keep" data-role="AXButton" data-title="Cancel">Cancel</button><button class="push primary" id="remove" data-role="AXButton" data-title="Delete">Delete</button></div></div>
   </div></div>`,
  `var store = { open: 1, deleted: [], notes: [
     ["Budget 2027", "Rent 1,200. Food 400. Savings 300."], ["Groceries", "milk, eggs, bread"], ["Ideas for the talk", "Start with the demo."],
     ["Books to read", "The long way home."], ["Call list", "Dentist on Monday."], ["Holiday plan", "Lisbon in May."],
     ["Meeting with the bank", "Ask about the loan."], ["Recipes", "Lentil soup: onion, carrot, lentils."], ["Server notes", "Restart at night only."],
     ["Things to pack", "Charger, passport."], ["Travel receipts", "Taxi 23."], ["Unread papers", "Three on the desk."],
     ["Weekly review", "Friday at four."], ["Workshop notes", "Bring markers."], ["Zebra crossing", "The council answered: next spring."]
   ].map(function (item) { return { name: item[0], text: item[1] }; }) };
   var list = document.getElementById("list"), editor = document.getElementById("editor"), search = document.getElementById("search"), sheet = document.getElementById("sheet");
   function draw() {
     var word = search.value.trim().toLowerCase();
     list.innerHTML = "";
     store.notes.forEach(function (note, index) {
       if (word && note.name.toLowerCase().indexOf(word) < 0) return;
       var row = document.createElement("div");
       row.className = "row" + (index === store.open ? " chosen" : "");
       row.setAttribute("data-role", "AXStaticText");
       row.setAttribute("data-title", note.name);
       row.innerHTML = "";
       row.appendChild(document.createTextNode(note.name));
       var small = document.createElement("small"); small.textContent = "Yesterday"; row.appendChild(small);
       row.onclick = function () { store.open = index; draw(); };
       list.appendChild(row);
     });
     // A note that the search left out is not shown: the editor is empty until a result is clicked.
     var open = store.notes[store.open];
     var out = !open || (word && open.name.toLowerCase().indexOf(word) < 0);
     editor.disabled = out;
     editor.placeholder = out ? "No note is open" : "";
     if (out) editor.value = "";
     else if (document.activeElement !== editor || editor.dataset.of !== String(store.open)) editor.value = open.text;
     editor.dataset.of = out ? "" : String(store.open);
   }
   editor.oninput = function () {
     var open = store.notes[store.open];
     if (!open) return;
     open.text = editor.value;
     // A new note takes its first line as its name, as a notes app does.
     if (open.fresh) { open.name = (editor.value.split("\\n")[0] || "New note").slice(0, 60); draw(); }
   };
   search.oninput = draw;
   document.getElementById("new").onclick = function () {
     store.notes.unshift({ name: "New note", text: "", fresh: true }); store.open = 0; search.value = ""; draw(); editor.value = ""; editor.focus();
   };
   document.getElementById("trash").onclick = function () {
     var open = store.notes[store.open]; if (!open) return;
     var ask = document.getElementById("ask"), text = "Delete the note \\u201c" + open.name + "\\u201d?";
     ask.textContent = text; ask.setAttribute("data-title", text); sheet.hidden = false;
   };
   document.getElementById("keep").onclick = function () { sheet.hidden = true; };
   document.getElementById("remove").onclick = function () {
     var gone = store.notes.splice(store.open, 1)[0]; store.deleted.push(gone.name); store.open = Math.min(store.open, store.notes.length - 1); sheet.hidden = true; draw();
   };
   window.state = function () {
     return { open: editor.disabled || !store.notes[store.open] ? "" : store.notes[store.open].name, deleted: store.deleted,
       notes: store.notes.map(function (note) { return { name: note.name, text: note.text }; }) };
   };
   draw();`,
);

const settings = page(
  "Settings",
  `.pane { flex: 1; padding: 24px 40px; }
   .setting { display: flex; justify-content: space-between; align-items: center; padding: 14px 0; border-bottom: 1px solid #e3e3e3; font-size: 14px; }
   .switch { width: 42px; height: 24px; border-radius: 12px; background: #d1d1d6; position: relative; display: inline-block; }
   .switch i { position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.3); }
   .switch.on { background: #34c759; } .switch.on i { left: 20px; }`,
  `<div class="window"><div class="titlebar">${lights}<div class="title">Settings</div></div><div class="content"><div class="pane" id="pane">
     <h2 data-role="AXStaticText" data-title="General">General</h2></div></div></div>`,
  `var turned = { "Wi-Fi": true, "Bluetooth": false, "Dark mode": false, "Notifications": true, "Automatic updates": true };
   // The first two say their state to the Accessibility tree. The others show it in the picture only.
   var named = { "Wi-Fi": true, "Bluetooth": true };
   var changes = [];
   var pane = document.getElementById("pane");
   Object.keys(turned).forEach(function (label) {
     var row = document.createElement("div"); row.className = "setting";
     var name = document.createElement("span"); name.textContent = label; row.appendChild(name);
     var knob = document.createElement("span"); knob.setAttribute("data-role", "AXCheckBox"); knob.setAttribute("data-title", label);
     knob.appendChild(document.createElement("i"));
     function show() { knob.className = "switch" + (turned[label] ? " on" : ""); if (named[label]) knob.setAttribute("data-value", turned[label] ? "1" : "0"); }
     knob.onclick = function () { turned[label] = !turned[label]; changes.push(label); show(); };
     show(); row.appendChild(knob); pane.appendChild(row);
   });
   window.state = function () { return { switches: turned, changes: changes }; };`,
);

const documentApp = page(
  "Report",
  `.doc { flex: 1; padding: 30px 50px; font: 15px/1.7 -apple-system, Arial, sans-serif; border: 0; outline: 0; resize: none; }
   .buttons .left { margin-right: auto; }`,
  `<div class="window"><div class="titlebar">${lights}<div class="title" id="name" data-role="AXStaticText" data-title="Report (Edited)">Report (Edited)</div></div>
   <div class="content"><textarea class="doc" id="doc" data-role="AXTextArea" data-title="">Quarterly report. Sales rose in the north.</textarea>
     <div class="sheet" id="sheet"><h3 data-role="AXStaticText" data-title="Do you want to save the changes made to the document Report?">Do you want to save the changes made to the document Report?</h3>
       <p data-role="AXStaticText" data-title="Your changes will be lost if you don't save them.">Your changes will be lost if you don't save them.</p>
       <div class="buttons"><button class="push left" id="dont" data-role="AXButton" data-title="Don't Save">Don't Save</button>
       <button class="push" id="cancel" data-role="AXButton" data-title="Cancel">Cancel</button>
       <button class="push primary" id="save" data-role="AXButton" data-title="Save">Save</button></div></div>
   </div></div>`,
  `var outcome = "open";
   function close(how, title) { outcome = how; document.getElementById("sheet").hidden = true; var name = document.getElementById("name"); name.textContent = title; name.setAttribute("data-title", title); }
   document.getElementById("save").onclick = function () { close("saved", "Report"); };
   document.getElementById("dont").onclick = function () { close("thrown away", "Report"); };
   document.getElementById("cancel").onclick = function () { close("canceled", "Report (Edited)"); };
   window.state = function () { return { outcome: outcome }; };`,
);

const login = page(
  "Sign in",
  `.form { margin: 90px auto; width: 340px; } .form label { display: block; margin: 14px 0 5px; color: #444; }
   .form input { width: 100%; height: 32px; border: 1px solid #c4c4c4; border-radius: 7px; padding: 0 9px; font: inherit; }
   .form button { margin-top: 22px; width: 100%; height: 34px; } .hello { margin: 120px auto; font-size: 22px; }`,
  `<div class="window"><div class="titlebar">${lights}<div class="title">Sign in to Ledger</div></div><div class="content" id="content"><div class="form">
     <h2 data-role="AXStaticText" data-title="Sign in">Sign in</h2>
     <label>Email</label><input id="email" data-role="AXTextField" data-title="Email">
     <label>Password</label><input id="password" type="password" data-role="AXSecureTextField" data-title="Password">
     <button class="push primary" id="go" data-role="AXButton" data-title="Sign in">Sign in</button>
     <p id="problem" data-role="AXStaticText" data-title=""></p>
   </div></div></div>`,
  `var signedIn = "";
   document.getElementById("go").onclick = function () {
     var email = document.getElementById("email").value, password = document.getElementById("password").value, problem = document.getElementById("problem");
     if (!email || !password) { var text = "Give the email and the password."; problem.textContent = text; problem.setAttribute("data-title", text); return; }
     signedIn = email;
     var hello = "Welcome, " + email;
     document.getElementById("content").innerHTML = "";
     var line = document.createElement("div"); line.className = "hello"; line.setAttribute("data-role", "AXStaticText"); line.setAttribute("data-title", hello); line.textContent = hello;
     document.getElementById("content").appendChild(line);
   };
   window.state = function () { var field = document.getElementById("password"); return { signedIn: signedIn, email: (document.getElementById("email") || {}).value || "", passwordLength: field ? field.value.length : -1 }; };`,
);

const star = (index: number) =>
  `<svg class="star" data-star="${index}" viewBox="0 0 24 24"><path d="M12 3l2.7 5.7 6.3.8-4.6 4.3 1.2 6.2L12 17l-5.6 3 1.2-6.2L3 9.5l6.3-.8z" fill="none" stroke="#b98900" stroke-width="1.4"/></svg>`;
const board = page(
  "Board",
  `.board { flex: 1; position: relative; background: #fafafa; background-image: radial-gradient(#d9d9d9 1px, transparent 1px); background-size: 22px 22px; }
   .banner { position: absolute; left: 250px; top: 16px; width: 600px; height: 38px; background: #fff4cc; border: 1px solid #e6cf7a; border-radius: 8px; display: flex; align-items: center; padding: 0 12px; }
   .banner[hidden] { display: none; } .banner span.msg { flex: 1; } .banner .x { width: 18px; height: 18px; line-height: 16px; text-align: center; border-radius: 4px; color: #6b5a12; font-size: 16px; }
   .sticky { position: absolute; width: 160px; height: 120px; padding: 14px; font-size: 17px; font-weight: 600; box-shadow: 0 3px 8px rgba(0,0,0,.2); }
   .sticky.chosen { outline: 3px solid #0a7aff; }
   .rating { position: absolute; left: 760px; top: 560px; background: #fff; border: 1px solid #d0d0d0; border-radius: 10px; padding: 10px 14px; display: flex; align-items: center; gap: 4px; }
   .rating b { margin-right: 10px; font-weight: 600; } .star { width: 22px; height: 22px; display: block; }`,
  `<div class="window"><div class="titlebar">${lights}<div class="title">Board</div></div><div class="content">
     <div class="board" data-role="AXGroup" data-title="">
       <div class="banner" id="banner"><span class="msg">Two people are looking at this board.</span><span class="x" id="x">×</span></div>
       <div class="sticky" style="left:170px;top:170px;background:#ffe27a">Launch</div>
       <div class="sticky" style="left:420px;top:300px;background:#a9e5a1">Pricing</div>
       <div class="sticky" style="left:700px;top:150px;background:#ffb3c1">Hiring</div>
       <div class="rating"><b>Rate this board</b>${[1, 2, 3, 4, 5].map(star).join("")}</div>
     </div></div></div>`,
  `var held = { stars: 0, banner: true, chosen: "" };
   document.getElementById("x").onclick = function () { held.banner = false; document.getElementById("banner").hidden = true; };
   Array.prototype.forEach.call(document.querySelectorAll(".star"), function (el) {
     el.onclick = function () {
       held.stars = Number(el.getAttribute("data-star"));
       Array.prototype.forEach.call(document.querySelectorAll(".star"), function (other) {
         other.querySelector("path").setAttribute("fill", Number(other.getAttribute("data-star")) <= held.stars ? "#f5b301" : "none");
       });
     };
   });
   Array.prototype.forEach.call(document.querySelectorAll(".sticky"), function (el) {
     el.onclick = function () {
       held.chosen = el.textContent;
       Array.prototype.forEach.call(document.querySelectorAll(".sticky"), function (other) { other.className = "sticky" + (other === el ? " chosen" : ""); });
     };
   });
   window.state = function () { return held; };`,
);

export interface App {
  app: { name: string; bundleId: string; window: string };
  html: string;
}
export const apps = {
  notes: {
    app: { name: "Notes", bundleId: "com.example.notes", window: "Notes" },
    html: notes,
  },
  settings: {
    app: {
      name: "Settings",
      bundleId: "com.example.settings",
      window: "Settings",
    },
    html: settings,
  },
  document: {
    app: { name: "Pages", bundleId: "com.example.pages", window: "Report" },
    html: documentApp,
  },
  login: {
    app: {
      name: "Ledger",
      bundleId: "com.example.ledger",
      window: "Sign in to Ledger",
    },
    html: login,
  },
  board: {
    app: { name: "Board", bundleId: "com.example.board", window: "Board" },
    html: board,
  },
} satisfies Record<string, App>;
