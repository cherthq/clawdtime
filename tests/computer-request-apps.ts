/**
 * Small apps that work, for the whole-request test (computer-request.eval.ts).
 *
 * Each one is a page that looks like a Mac app window and behaves like one:
 * a row opens a note, text goes into the editor, a switch turns, a dialog
 * closes, a menu opens while the pointer rests on it, a card moves by a drag.
 * An element that the Accessibility tree of a real app would name carries
 * data-role and data-title. `window.state()` gives what the app holds, for
 * the check at the end of a request. `sites` holds plain web pages for the
 * requests in a browser. Every name here is invented.
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
   function fresh() {
     store.notes.unshift({ name: "New note", text: "", fresh: true }); store.open = 0; search.value = ""; draw(); editor.value = ""; editor.focus();
   }
   document.getElementById("new").onclick = fresh;
   // Command-N makes a new note, as the button does.
   document.addEventListener("keydown", function (event) {
     if (event.metaKey && !event.shiftKey && !event.altKey && (event.key === "n" || event.key === "N")) { event.preventDefault(); fresh(); }
   });
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

const customers = [
  ["Amber Mill", "3 Nov 2026", "$1,240.00"],
  ["Birch and Sons", "4 Nov 2026", "$860.50"],
  ["Cedar Works", "5 Nov 2026", "$2,315.75"],
  ["Dune Trading", "7 Nov 2026", "$410.00"],
  ["Elm Street Bakery", "8 Nov 2026", "$96.20"],
  ["Fjord Logistics", "10 Nov 2026", "$5,120.00"],
  ["Granite Tools", "11 Nov 2026", "$734.90"],
  ["Harbor Print", "12 Nov 2026", "$1,999.99"],
  ["Ivory Lane", "14 Nov 2026", "$58.00"],
  ["Juniper Farms", "15 Nov 2026", "$3,402.10"],
];
// Ten links with the same name: only the row says which invoice one opens.
const invoices = page(
  "Invoices",
  `table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 9px 16px; border-bottom: 1px solid #e6e6e6; }
   th { background: #f3f3f3; font-weight: 600; } a { color: #0a66d8; } .wrap { flex: 1; padding: 10px 14px; overflow: hidden; }
   .detail { width: 300px; border-left: 1px solid #ddd; padding: 20px; background: #fafafa; }`,
  `<div class="window"><div class="titlebar">${lights}<div class="title">Invoices</div></div><div class="content">
     <div class="wrap"><table id="table"><tr><th>Customer</th><th>Date</th><th>Amount</th><th></th></tr></table></div>
     <div class="detail"><h3 data-role="AXStaticText" data-title="Invoice">Invoice</h3><p id="detail" data-role="AXStaticText" data-title="Choose an invoice to see it.">Choose an invoice to see it.</p></div>
   </div></div>`,
  `var rows = ${JSON.stringify(customers)};
   var opened = "", table = document.getElementById("table"), detail = document.getElementById("detail");
   rows.forEach(function (row) {
     var line = document.createElement("tr");
     row.forEach(function (text) { var cell = document.createElement("td"); cell.textContent = text; cell.setAttribute("data-role", "AXStaticText"); cell.setAttribute("data-title", text); line.appendChild(cell); });
     var last = document.createElement("td"), link = document.createElement("a");
     link.href = "#"; link.textContent = "View"; link.setAttribute("data-role", "AXLink"); link.setAttribute("data-title", "View");
     link.onclick = function (event) {
       event.preventDefault(); opened = row[0];
       var text = "Invoice of " + row[0] + ", " + row[1] + ": " + row[2] + ".";
       detail.textContent = text; detail.setAttribute("data-title", text);
     };
     last.appendChild(link); line.appendChild(last); table.appendChild(line);
   });
   window.state = function () { return { opened: opened }; };`,
);

// A menu that opens only while the pointer rests on it. A press on its title closes it, as on many web menus.
const reports = page(
  "Reports",
  `.menubar { height: 36px; display: flex; align-items: center; gap: 4px; padding: 0 10px; border-bottom: 1px solid #ddd; background: #f7f7f7; position: relative; z-index: 3; }
   .menu { position: relative; } .menubar span.name { display: inline-block; padding: 6px 12px; border-radius: 5px; }
   .menu.open span.name { background: #dbe8ff; }
   .items { position: absolute; left: 0; top: 30px; width: 180px; background: #fff; border: 1px solid #c8c8c8; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.2); padding: 5px; }
   .items[hidden] { display: none; } .item { padding: 7px 12px; border-radius: 5px; } .item:hover { background: #0a7aff; color: #fff; }
   .hint { margin-left: auto; color: #777; } .doc { flex: 1; padding: 30px 50px; font-size: 15px; line-height: 1.7; }
   .status { padding: 0 50px; color: #1f7a33; font-weight: 600; }`,
  `<div class="window"><div class="titlebar">${lights}<div class="title">Reports</div></div>
   <div class="menubar"><span class="name" data-role="AXMenuBarItem" data-title="File">File</span><span class="name" data-role="AXMenuBarItem" data-title="Edit">Edit</span>
     <div class="menu" id="export"><span class="name" id="export-title" data-role="AXMenuBarItem" data-title="Export">Export</span>
       <div class="items" id="items" hidden>
         <div class="item" data-as="PDF" data-role="AXMenuItem" data-title="PDF">PDF</div>
         <div class="item" data-as="CSV" data-role="AXMenuItem" data-title="CSV">CSV</div>
         <div class="item" data-as="Plain text" data-role="AXMenuItem" data-title="Plain text">Plain text</div>
       </div></div>
     <span class="hint" data-role="AXStaticText" data-title="Point at a menu to open it.">Point at a menu to open it.</span></div>
   <div class="content" style="flex-direction:column"><div class="doc" data-role="AXTextArea" data-title="" data-value="Quarterly report. Sales rose in the north.">Quarterly report. Sales rose in the north.</div>
     <p class="status" id="status" data-role="AXStaticText" data-title=""></p></div></div>`,
  `var exported = "", menu = document.getElementById("export"), items = document.getElementById("items"), status = document.getElementById("status");
   var pressed = false;
   function show(open) { items.hidden = !open; menu.className = "menu" + (open ? " open" : ""); }
   menu.addEventListener("mousemove", function (event) { if (!event.buttons && !pressed) show(true); });
   menu.addEventListener("mouseleave", function () { pressed = false; show(false); });
   document.getElementById("export-title").addEventListener("mousedown", function () { pressed = true; show(false); });
   Array.prototype.forEach.call(document.querySelectorAll(".item"), function (item) {
     item.addEventListener("click", function () {
       exported = item.getAttribute("data-as"); show(false);
       var text = "Exported as " + exported + "."; status.textContent = text; status.setAttribute("data-title", text);
     });
   });
   window.state = function () { return { exported: exported }; };`,
);

// A board of cards in columns. A card moves only by a drag: press on it, move, let go over a column.
const tasks = page(
  "Tasks",
  `.board { flex: 1; display: flex; gap: 16px; padding: 18px; background: #f3f4f6; }
   .column { flex: 1; background: #e9ebef; border-radius: 10px; padding: 10px; }
   .column h4 { margin: 4px 6px 12px; } .card { background: #fff; border-radius: 8px; padding: 12px; margin-bottom: 10px; box-shadow: 0 1px 3px rgba(0,0,0,.15); font-weight: 600; user-select: none; }
   .card.lifted { opacity: .4; } .ghost { position: fixed; pointer-events: none; z-index: 9; width: 220px; }`,
  `<div class="window"><div class="titlebar">${lights}<div class="title">Tasks</div></div><div class="content"><div class="board" id="board"></div></div></div>`,
  `var columns = { "To do": ["Write the invoice", "Call the printer"], "Doing": ["Plan the launch"], "Done": ["Book the venue"] };
   var board = document.getElementById("board"), lifted = null, ghost = null;
   function draw() {
     board.innerHTML = "";
     Object.keys(columns).forEach(function (name) {
       var column = document.createElement("div"); column.className = "column";
       column.setAttribute("data-role", "AXList"); column.setAttribute("data-title", name); column.setAttribute("data-column", name);
       var head = document.createElement("h4"); head.textContent = name; column.appendChild(head);
       columns[name].forEach(function (text) {
         var card = document.createElement("div"); card.className = "card"; card.textContent = text;
         card.setAttribute("data-role", "AXGroup"); card.setAttribute("data-title", text);
         card.addEventListener("mousedown", function (event) {
           event.preventDefault(); lifted = text; card.className = "card lifted";
           ghost = document.createElement("div"); ghost.className = "card ghost"; ghost.textContent = text; document.body.appendChild(ghost); place(event);
         });
         column.appendChild(card);
       });
       board.appendChild(column);
     });
   }
   function place(event) { if (ghost) { ghost.style.left = (event.clientX - 30) + "px"; ghost.style.top = (event.clientY - 18) + "px"; } }
   document.addEventListener("mousemove", place);
   document.addEventListener("mouseup", function (event) {
     if (!lifted) return;
     var text = lifted; lifted = null;
     if (ghost) { ghost.remove(); ghost = null; }
     var below = document.elementFromPoint(event.clientX, event.clientY);
     var column = below && below.closest("[data-column]");
     if (column) {
       Object.keys(columns).forEach(function (name) { columns[name] = columns[name].filter(function (card) { return card !== text; }); });
       columns[column.getAttribute("data-column")].push(text);
     }
     draw();
   });
   window.state = function () { return { columns: columns }; };
   draw();`,
);

// Two sliders. Only the knob moves a value: a press on the track does nothing.
const sound = page(
  "Sound",
  `.pane { flex: 1; padding: 24px 40px; } .row { display: flex; align-items: center; gap: 24px; padding: 20px 0; border-bottom: 1px solid #e3e3e3; font-size: 14px; }
   .row .name { width: 160px; } .slider { position: relative; width: 320px; height: 22px; }
   .track { position: absolute; left: 0; right: 0; top: 9px; height: 4px; border-radius: 2px; background: #d1d1d6; }
   .fill { position: absolute; left: 0; top: 9px; height: 4px; border-radius: 2px; background: #0a7aff; }
   .knob { position: absolute; top: 0; width: 22px; height: 22px; margin-left: -11px; border-radius: 50%; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.45); }
   .number { width: 50px; color: #555; }`,
  `<div class="window"><div class="titlebar">${lights}<div class="title">Sound</div></div><div class="content"><div class="pane" id="pane">
     <h2 data-role="AXStaticText" data-title="Sound">Sound</h2></div>
     <p style="position:absolute;left:40px;bottom:30px;color:#777" data-role="AXStaticText" data-title="Drag a knob to change a level.">Drag a knob to change a level.</p></div></div>`,
  `var levels ={ "Output volume": 20, "Alert volume": 50 }, dragging = null, pane = document.getElementById("pane");
   Object.keys(levels).forEach(function (name, index) {
     var row = document.createElement("div"); row.className = "row";
     var label = document.createElement("span"); label.className = "name"; label.textContent = name; row.appendChild(label);
     var slider = document.createElement("div"); slider.className = "slider"; slider.id = index === 0 ? "volume" : "alert";
     slider.setAttribute("data-role", "AXSlider"); slider.setAttribute("data-title", name);
     var track = document.createElement("div"); track.className = "track";
     var fill = document.createElement("div"); fill.className = "fill";
     var knob = document.createElement("div"); knob.className = "knob";
     slider.appendChild(track); slider.appendChild(fill); slider.appendChild(knob); row.appendChild(slider);
     var number = document.createElement("span"); number.className = "number"; row.appendChild(number);
     function show() { var value = levels[name]; knob.style.left = value + "%"; fill.style.width = value + "%"; slider.setAttribute("data-value", String(value)); number.textContent = value + "%"; }
     knob.addEventListener("mousedown", function (event) { event.preventDefault(); dragging = { name: name, slider: slider, show: show }; });
     show(); pane.appendChild(row);
   });
   document.addEventListener("mousemove", function (event) {
     if (!dragging) return;
     var r = dragging.slider.getBoundingClientRect();
     levels[dragging.name] = Math.round(Math.min(1, Math.max(0, (event.clientX - r.left) / r.width)) * 100); dragging.show();
   });
   document.addEventListener("mouseup", function () { dragging = null; });
   window.state = function () { return { volume: levels["Output volume"], alert: levels["Alert volume"] }; };`,
);

/*
 * Apps for requests of several steps, where a plan helps: find, copy and
 * confirm; sign in, then change a setting; a form of three pages.
 */

/** The notes app with one more note, whose name holds the word invoice, far down the list. */
const invoiceRow = `["Workshop notes", "Bring markers."]`;
if (!notes.includes(invoiceRow))
  throw new Error("The notes app changed: the invoice note has no place.");
const invoiceNotes = notes.replace(
  invoiceRow,
  `${invoiceRow}, ["Workshop invoice", "From the print shop. Invoice number 30417, due on Friday."]`,
);

/** Sign in, then a settings page with switches that say their state. */
const ledger = page(
  "Ledger",
  `.form { margin: 90px auto; width: 340px; } .form label { display: block; margin: 14px 0 5px; color: #444; }
   .form input { width: 100%; height: 32px; border: 1px solid #c4c4c4; border-radius: 7px; padding: 0 9px; font: inherit; }
   .form button { margin-top: 22px; width: 100%; height: 34px; } .home { margin: 80px auto; width: 460px; font-size: 18px; }
   .home button { margin-top: 18px; }
   .pane { flex: 1; padding: 24px 40px; } .setting { display: flex; justify-content: space-between; align-items: center; padding: 14px 0; border-bottom: 1px solid #e3e3e3; font-size: 14px; }
   .switch { width: 42px; height: 24px; border-radius: 12px; background: #d1d1d6; position: relative; display: inline-block; }
   .switch i { position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.3); }
   .switch.on { background: #34c759; } .switch.on i { left: 20px; }`,
  `<div class="window"><div class="titlebar">${lights}<div class="title">Ledger</div></div><div class="content">
     <div class="form" id="form"><h2 data-role="AXStaticText" data-title="Sign in">Sign in</h2>
       <label>Email</label><input id="email" data-role="AXTextField" data-title="Email">
       <label>Password</label><input id="password" type="password" data-role="AXSecureTextField" data-title="Password">
       <button class="push primary" id="go" data-role="AXButton" data-title="Sign in">Sign in</button>
       <p id="problem" data-role="AXStaticText" data-title=""></p></div>
     <div class="home" id="home" hidden><div id="hello" data-role="AXStaticText" data-title=""></div>
       <button class="push" id="open" data-role="AXButton" data-title="Settings">Settings</button></div>
     <div class="pane" id="pane" hidden><h2 data-role="AXStaticText" data-title="Settings">Settings</h2></div>
   </div></div>`,
  `var signedIn = "", passwordLength = 0, changes = [];
   var turned = { "Email receipts": true, "Paper statements": false, "Weekly summary": false };
   document.getElementById("go").onclick = function () {
     var email = document.getElementById("email").value, password = document.getElementById("password").value, problem = document.getElementById("problem");
     if (!email || !password) { var text = "Give the email and the password."; problem.textContent = text; problem.setAttribute("data-title", text); return; }
     signedIn = email; passwordLength = password.length;
     document.getElementById("form").hidden = true; document.getElementById("home").hidden = false;
     var hello = document.getElementById("hello"), words = "Welcome, " + email; hello.textContent = words; hello.setAttribute("data-title", words);
   };
   document.getElementById("open").onclick = function () { document.getElementById("home").hidden = true; document.getElementById("pane").hidden = false; };
   var pane = document.getElementById("pane");
   Object.keys(turned).forEach(function (label) {
     var row = document.createElement("div"); row.className = "setting";
     var name = document.createElement("span"); name.textContent = label; row.appendChild(name);
     var knob = document.createElement("span"); knob.setAttribute("data-role", "AXCheckBox"); knob.setAttribute("data-title", label);
     knob.appendChild(document.createElement("i"));
     function show() { knob.className = "switch" + (turned[label] ? " on" : ""); knob.setAttribute("data-value", turned[label] ? "1" : "0"); }
     knob.onclick = function () { turned[label] = !turned[label]; changes.push(label); show(); };
     show(); row.appendChild(knob); pane.appendChild(row);
   });
   window.state = function () { return { signedIn: signedIn, passwordLength: passwordLength, switches: turned, changes: changes }; };`,
);

/** A form of three pages: a name, a date, a seat. Sending it shows a reference. */
const trip = page(
  "Trip request",
  `.step { margin: 70px auto; width: 380px; } .step label { display: block; margin: 14px 0 5px; color: #444; }
   .step input { width: 100%; height: 32px; border: 1px solid #c4c4c4; border-radius: 7px; padding: 0 9px; font: inherit; }
   .step .next { margin-top: 22px; } .seat { display: flex; align-items: center; gap: 8px; margin: 10px 0; font-size: 14px; }
   .radio { width: 18px; height: 18px; border-radius: 50%; border: 2px solid #8a8a8e; display: inline-block; }
   .radio.on { border-color: #0a7aff; background: radial-gradient(#0a7aff 45%, transparent 50%); }`,
  `<div class="window"><div class="titlebar">${lights}<div class="title">Trip request</div></div><div class="content">
     <div class="step" id="one"><h2 data-role="AXStaticText" data-title="Step 1 of 3: who travels">Step 1 of 3: who travels</h2>
       <label>Full name</label><input id="name" data-role="AXTextField" data-title="Full name">
       <button class="push primary next" id="next1" data-role="AXButton" data-title="Next">Next</button>
       <p class="problem" data-role="AXStaticText" data-title=""></p></div>
     <div class="step" id="two" hidden><h2 data-role="AXStaticText" data-title="Step 2 of 3: when">Step 2 of 3: when</h2>
       <label>Travel date</label><input id="date" data-role="AXTextField" data-title="Travel date">
       <button class="push primary next" id="next2" data-role="AXButton" data-title="Next">Next</button>
       <p class="problem" data-role="AXStaticText" data-title=""></p></div>
     <div class="step" id="three" hidden><h2 data-role="AXStaticText" data-title="Step 3 of 3: seat">Step 3 of 3: seat</h2>
       <div class="seat"><span class="radio" data-seat="Window" data-role="AXRadioButton" data-title="Window"></span>Window</div>
       <div class="seat"><span class="radio" data-seat="Aisle" data-role="AXRadioButton" data-title="Aisle"></span>Aisle</div>
       <button class="push primary next" id="send" data-role="AXButton" data-title="Send request">Send request</button>
       <p class="problem" data-role="AXStaticText" data-title=""></p></div>
     <div class="step" id="sent" hidden><h2 data-role="AXStaticText" data-title="Request sent">Request sent</h2>
       <p data-role="AXStaticText" data-title="Your reference is TR-5521.">Your reference is TR-5521.</p></div>
   </div></div>`,
  `var held = { name: "", date: "", seat: "", sent: false };
   function show(id) { ["one", "two", "three", "sent"].forEach(function (step) { document.getElementById(step).hidden = step !== id; }); }
   function problem(id, text) { var line = document.querySelector("#" + id + " .problem"); line.textContent = text; line.setAttribute("data-title", text); }
   document.getElementById("next1").onclick = function () {
     held.name = document.getElementById("name").value.trim();
     if (!held.name) return problem("one", "Give the full name.");
     show("two");
   };
   document.getElementById("next2").onclick = function () {
     held.date = document.getElementById("date").value.trim();
     if (!held.date) return problem("two", "Give the travel date.");
     show("three");
   };
   Array.prototype.forEach.call(document.querySelectorAll(".radio"), function (el) {
     el.setAttribute("data-value", "0");
     el.onclick = function () {
       held.seat = el.getAttribute("data-seat");
       Array.prototype.forEach.call(document.querySelectorAll(".radio"), function (other) {
         var on = other === el; other.className = "radio" + (on ? " on" : ""); other.setAttribute("data-value", on ? "1" : "0");
       });
     };
   });
   document.getElementById("send").onclick = function () {
     if (!held.seat) return problem("three", "Choose a seat.");
     held.sent = true; show("sent");
   };
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
  invoices: {
    app: { name: "Ledger", bundleId: "com.example.ledger", window: "Invoices" },
    html: invoices,
  },
  reports: {
    app: { name: "Reports", bundleId: "com.example.reports", window: "Report" },
    html: reports,
  },
  tasks: {
    app: { name: "Tasks", bundleId: "com.example.tasks", window: "Tasks" },
    html: tasks,
  },
  sound: {
    app: {
      name: "Settings",
      bundleId: "com.example.settings",
      window: "Sound",
    },
    html: sound,
  },
  invoiceNotes: {
    app: { name: "Notes", bundleId: "com.example.notes", window: "Notes" },
    html: invoiceNotes,
  },
  ledger: {
    app: { name: "Ledger", bundleId: "com.example.ledger", window: "Ledger" },
    html: ledger,
  },
  trip: {
    app: {
      name: "Trips",
      bundleId: "com.example.trips",
      window: "Trip request",
    },
    html: trip,
  },
} satisfies Record<string, App>;

/** The app and window that a browser case stands for. The window follows the title of the tab in front. */
export const browserApp = {
  name: "Google Chrome",
  bundleId: "com.google.Chrome",
};

const web = (title: string, body: string, script = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
  body { margin: 0; font: 15px -apple-system, "Helvetica Neue", Arial, sans-serif; color: #1d1d1f; background: #fff; }
  main { max-width: 720px; margin: 40px auto; padding: 0 20px; } input, select, button { font: inherit; padding: 6px 10px; }
  </style></head><body>${body}<script>${script}</script></body></html>`;

/**
 * Web pages for the browser cases, by address. The eval serves them inside
 * the headless browser, so no request leaves this computer. Every name and
 * address here is invented.
 */
export const sites: Record<string, string> = {
  // A list of choices: the page script chooses in it by the text of a choice.
  "https://shop.example/checkout": web(
    "Checkout - Shop",
    `<main><h1>Checkout</h1><form id="form">
       <p><label for="name">Name</label><br><input id="name" value="Ada Brook"></p>
       <p><label for="country">Country</label><br><select id="country"><option value="">Choose a country</option><option>Spain</option><option>Portugal</option><option>France</option><option>Italy</option></select></p>
       <p><button type="submit">Save</button></p></form><p id="said" role="status"></p></main>`,
    `var saved = "", country = document.getElementById("country"), said = document.getElementById("said");
     document.getElementById("form").addEventListener("submit", function (event) {
       event.preventDefault();
       if (!country.value) { said.textContent = "Choose a country first."; return; }
       saved = country.value; said.textContent = "Saved. Country: " + saved + ".";
     });
     window.state = function () { return { country: country.value, saved: saved }; };`,
  ),
  // The result comes a moment after the search: first the page says that it searches.
  "https://travel.example/": web(
    "Flights - Travel",
    `<main><h1>Find a flight</h1><form id="find" role="search"><input id="q" type="search" aria-label="Where to" placeholder="Where to"> <button type="submit">Search</button></form>
       <div id="out"></div></main>`,
    `var searched = "", shown = false, out = document.getElementById("out");
     document.getElementById("find").addEventListener("submit", function (event) {
       event.preventDefault(); searched = document.getElementById("q").value.trim(); shown = false;
       out.textContent = "Searching for flights to " + searched + "...";
       setTimeout(function () {
         shown = true;
         if (/lisbon/i.test(searched)) out.innerHTML = "<h2>Flights to Lisbon</h2><ul><li>Tuesday, 07:10, 143 EUR</li><li>Wednesday, 12:30, 89 EUR</li><li>Friday, 18:45, 120 EUR</li></ul>";
         else out.textContent = "No flights found to " + searched + ".";
       }, 1200);
     });
     window.state = function () { return { searched: searched, shown: shown }; };`,
  ),
  "https://mail.example/": web(
    "Inbox - Mailbox",
    `<main><h1>Inbox</h1><p>Welcome to your inbox. You have 3 new messages.</p>
       <ul><li><a href="#">Lunch on Friday?</a></li><li><a href="#">Your order has shipped</a></li><li><a href="#">Team notes</a></li></ul></main>`,
  ),
  "https://docs.example/plan": web(
    "Quarterly plan - Docs",
    `<main><h1>Quarterly plan</h1><p>Goal 1: Grow the north by 8 percent.</p><p>Goal 2: Hire two people for support.</p><p>Goal 3: Ship the new price list in March.</p></main>`,
  ),
};
