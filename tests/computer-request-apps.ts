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

/*
 * Apps for long requests: 30 to 60 steps each, often across two apps. A
 * request can put more than one app on its desk (`desk` in
 * computer-request.eval.ts): the first is in front, and open_app brings
 * another one forward.
 */

/** A pop-up button: a click opens its menu under it, a click on a choice takes it. Any other click closes the menu. */
const popupStyle = `
  .popup { min-width: 180px; height: 30px; border: 1px solid #c4c4c4; border-radius: 6px; background: #fff; text-align: left; padding: 0 10px; font: inherit; }
  .menu { position: fixed; min-width: 180px; background: #fff; border: 1px solid #c8c8c8; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.2); padding: 5px; z-index: 9; }
  .menu[hidden] { display: none; } .menu div { padding: 6px 12px; border-radius: 5px; } .menu div:hover { background: #0a7aff; color: #fff; }`;
const popupScript = `
  var menus = [];
  function set(el, text) { el.textContent = text; el.setAttribute("data-title", text); }
  function popup(button, choices, chosen) {
    var menu = document.createElement("div"); menu.className = "menu"; menu.hidden = true; menus.push(menu);
    function show(value) { button.textContent = value || "Choose"; button.setAttribute("data-value", value || "Choose"); }
    choices.forEach(function (choice) {
      var item = document.createElement("div"); item.textContent = choice;
      item.setAttribute("data-role", "AXMenuItem"); item.setAttribute("data-title", choice);
      item.onclick = function (event) { event.stopPropagation(); menu.hidden = true; show(choice); chosen(choice); };
      menu.appendChild(item);
    });
    button.onclick = function (event) {
      event.stopPropagation(); var closed = menu.hidden; menus.forEach(function (other) { other.hidden = true; });
      var r = button.getBoundingClientRect(); menu.style.left = r.left + "px"; menu.style.top = (r.bottom + 3) + "px"; menu.hidden = !closed;
    };
    document.body.appendChild(menu); show("");
    return show;
  }
  document.addEventListener("click", function () { menus.forEach(function (menu) { menu.hidden = true; }); });`;
const field = (label: string, id: string) =>
  `<label>${label}</label><input id="${id}" data-role="AXTextField" data-title="${label}">`;
const choose = (label: string, id: string) =>
  `<label>${label}</label><button class="popup" id="${id}" data-role="AXPopUpButton" data-title="${label}"></button>`;
const formStyle = `.step { margin: 34px auto; width: 420px; } .step label { display: block; margin: 12px 0 4px; color: #444; }
   .step input { width: 100%; height: 30px; border: 1px solid #c4c4c4; border-radius: 7px; padding: 0 9px; font: inherit; }
   .step .next { margin-top: 20px; } .problem { color: #b3261e; } .summary p { margin: 3px 0; }`;
const problemLine = `<p class="problem" data-role="AXStaticText" data-title=""></p>`;

/** A lease application: twelve fields on three pages, a review, and the reference typed back to confirm it. */
const lease = page(
  "Lease application",
  `${formStyle}${popupStyle}`,
  `<div class="window"><div class="titlebar">${lights}<div class="title">Lease application</div></div><div class="content">
     <div class="step" id="one"><h2 data-role="AXStaticText" data-title="Step 1 of 3: about you">Step 1 of 3: about you</h2>
       ${field("First name", "first")}${field("Last name", "last")}${field("Email", "email")}${field("Phone", "phone")}
       <button class="push primary next" id="next1" data-role="AXButton" data-title="Next">Next</button>${problemLine}</div>
     <div class="step" id="two" hidden><h2 data-role="AXStaticText" data-title="Step 2 of 3: the home">Step 2 of 3: the home</h2>
       ${field("Street", "street")}${field("City", "city")}${field("Postcode", "postcode")}${field("Move-in date", "movein")}
       <button class="push primary next" id="next2" data-role="AXButton" data-title="Next">Next</button>${problemLine}</div>
     <div class="step" id="three" hidden><h2 data-role="AXStaticText" data-title="Step 3 of 3: details">Step 3 of 3: details</h2>
       ${choose("Occupants", "occupants")}${choose("Pets", "pets")}${choose("Contact time", "contact")}${field("Note to the landlord", "note")}
       <button class="push primary next" id="next3" data-role="AXButton" data-title="Review">Review</button>${problemLine}</div>
     <div class="step" id="review" hidden><h2 data-role="AXStaticText" data-title="Check your application">Check your application</h2><div class="summary" id="summary"></div>
       <button class="push next" id="back" data-role="AXButton" data-title="Back">Back</button>
       <button class="push primary next" id="send" data-role="AXButton" data-title="Send application">Send application</button></div>
     <div class="step" id="sent" hidden><h2 data-role="AXStaticText" data-title="Application sent">Application sent</h2>
       <p data-role="AXStaticText" data-title="Your reference is HA-48213.">Your reference is HA-48213.</p>
       <p data-role="AXStaticText" data-title="To confirm the application, type its reference here.">To confirm the application, type its reference here.</p>
       ${field("Reference", "reference")}
       <button class="push primary next" id="confirm" data-role="AXButton" data-title="Confirm">Confirm</button>${problemLine}</div>
   </div></div>`,
  `${popupScript}
   var held = { first: "", last: "", email: "", phone: "", street: "", city: "", postcode: "", movein: "", occupants: "", pets: "", contact: "", note: "", sent: false, confirmed: false, reference: "" };
   var labels = { first: "First name", last: "Last name", email: "Email", phone: "Phone", street: "Street", city: "City", postcode: "Postcode", movein: "Move-in date", occupants: "Occupants", pets: "Pets", contact: "Contact time", note: "Note to the landlord" };
   function show(id) { ["one", "two", "three", "review", "sent"].forEach(function (step) { document.getElementById(step).hidden = step !== id; }); }
   function problem(id, text) { set(document.querySelector("#" + id + " .problem"), text); }
   // A page goes on only with every field filled in.
   function take(id, keys) {
     var missing = keys.filter(function (key) { var el = document.getElementById(key); if (el.tagName === "INPUT") held[key] = el.value.trim(); return !held[key]; });
     problem(id, missing.length ? "Fill in every field on this page." : "");
     return !missing.length;
   }
   popup(document.getElementById("occupants"), ["1 person", "2 people", "3 people", "4 people"], function (value) { held.occupants = value; });
   popup(document.getElementById("pets"), ["No pets", "A cat", "A dog"], function (value) { held.pets = value; });
   popup(document.getElementById("contact"), ["Mornings", "Afternoons", "Evenings"], function (value) { held.contact = value; });
   document.getElementById("next1").onclick = function () { if (take("one", ["first", "last", "email", "phone"])) show("two"); };
   document.getElementById("next2").onclick = function () { if (take("two", ["street", "city", "postcode", "movein"])) show("three"); };
   document.getElementById("next3").onclick = function () {
     if (!take("three", ["occupants", "pets", "contact", "note"])) return;
     var summary = document.getElementById("summary"); summary.innerHTML = "";
     Object.keys(labels).forEach(function (key) { var line = document.createElement("p"); line.setAttribute("data-role", "AXStaticText"); set(line, labels[key] + ": " + held[key]); summary.appendChild(line); });
     show("review");
   };
   document.getElementById("back").onclick = function () { show("three"); };
   document.getElementById("send").onclick = function () { held.sent = true; show("sent"); };
   document.getElementById("confirm").onclick = function () {
     held.reference = document.getElementById("reference").value.trim();
     if (held.reference !== "HA-48213") return problem("sent", "That is not the reference above.");
     held.confirmed = true; problem("sent", "Confirmed. Application HA-48213 is complete.");
   };
   window.state = function () { return held; };`,
);

/** Kettles and more, each with its price and its delivery: name, price, delivery (0.00 is free). */
const products = [
  ["Brightwave K2 kettle", "29.00", "9.00"],
  ["Brightwave toaster", "45.00", "5.00"],
  ["Stonepad Steel kettle", "35.50", "0.00"],
  ["Stonepad Steel pan", "22.00", "4.00"],
  ["Cobalt One kettle", "31.00", "3.50"],
  ["Cobalt teapot", "18.00", "3.00"],
  ["Riverstone Mini kettle", "27.50", "12.00"],
  ["Riverstone fan", "39.00", "6.00"],
  ["Granite blender", "59.00", "0.00"],
  ["Amber mug", "9.00", "2.50"],
];
/** A shop: a search over a list of products. A product page shows its price, and its delivery on a tab of its own. */
const market = page(
  "Market",
  `.pane { flex: 1; padding: 20px 30px; } .search { width: 320px; height: 28px; border: 1px solid #c8c8c8; border-radius: 6px; padding: 0 8px; font: inherit; }
   .row { padding: 10px 4px; border-bottom: 1px solid #e6e6e6; color: #0a66d8; } .tabs { display: flex; gap: 8px; margin: 14px 0; }
   .tab { padding: 5px 14px; border: 1px solid #c8c8c8; border-radius: 6px; } .tab.on { background: #dbe8ff; border-color: #0a7aff; }`,
  `<div class="window"><div class="titlebar">${lights}<div class="title">Market</div></div><div class="content">
     <div class="pane" id="results"><input class="search" id="search" data-role="AXSearchField" data-title="Search" placeholder="Search"><div id="list"></div></div>
     <div class="pane" id="product" hidden><button class="push" id="back" data-role="AXButton" data-title="Back to results">Back to results</button>
       <h2 id="name" data-role="AXStaticText" data-title=""></h2><p id="price" data-role="AXStaticText" data-title=""></p>
       <div class="tabs"><span class="tab" id="tab-overview" data-role="AXRadioButton" data-title="Overview">Overview</span><span class="tab" id="tab-delivery" data-role="AXRadioButton" data-title="Delivery">Delivery</span></div>
       <div id="overview"><p data-role="AXStaticText" data-title="In stock.">In stock.</p></div>
       <div id="delivery" hidden><p id="fee" data-role="AXStaticText" data-title=""></p><p data-role="AXStaticText" data-title="Arrives in 3 to 5 days.">Arrives in 3 to 5 days.</p></div>
     </div></div></div>`,
  `var products = ${JSON.stringify(products)};
   var held = { opened: [], delivery: [] }, current = null;
   function el(id) { return document.getElementById(id); }
   function set(node, text) { node.textContent = text; node.setAttribute("data-title", text); }
   function draw() {
     var words = el("search").value.toLowerCase().split(/\\s+/).filter(Boolean), list = el("list");
     list.innerHTML = "";
     products.forEach(function (product) {
       var name = product[0].toLowerCase();
       if (!words.every(function (word) { return name.indexOf(word) >= 0; })) return;
       var row = document.createElement("div"); row.className = "row"; row.setAttribute("data-role", "AXLink"); set(row, product[0]);
       row.onclick = function () { open(product); }; list.appendChild(row);
     });
   }
   function tab(which) {
     el("overview").hidden = which !== "overview"; el("delivery").hidden = which !== "delivery";
     ["overview", "delivery"].forEach(function (name) { var t = el("tab-" + name); t.className = "tab" + (name === which ? " on" : ""); t.setAttribute("data-value", name === which ? "1" : "0"); });
   }
   function open(product) {
     current = product; held.opened.push(product[0]);
     set(el("name"), product[0]); set(el("price"), "Price $" + product[1]);
     set(el("fee"), product[2] === "0.00" ? "Free delivery" : "Delivery $" + product[2]);
     tab("overview"); el("results").hidden = true; el("product").hidden = false;
   }
   el("tab-overview").onclick = function () { tab("overview"); };
   el("tab-delivery").onclick = function () { tab("delivery"); if (current && held.delivery.indexOf(current[0]) < 0) held.delivery.push(current[0]); };
   el("back").onclick = function () { el("product").hidden = true; el("results").hidden = false; };
   el("search").oninput = draw; draw();
   window.state = function () { return held; };`,
);

/** Lists of things: a list in the sidebar opens it, New item adds a name and a note to the open list. */
const lists = page(
  "Lists",
  `.sidebar { width: 220px; border-right: 1px solid #ddd; background: #f6f6f6; } .name { padding: 10px 14px; border-bottom: 1px solid #e6e6e6; font-weight: 600; }
   .name.chosen { background: #ffe08a; } .pane { flex: 1; padding: 20px 30px; } .item { padding: 8px 0; border-bottom: 1px solid #eee; }
   .form { margin-top: 16px; width: 360px; } .form label { display: block; margin: 10px 0 4px; color: #444; }
   .form input { width: 100%; height: 30px; border: 1px solid #c4c4c4; border-radius: 7px; padding: 0 9px; font: inherit; } .form .buttons { margin-top: 14px; }`,
  `<div class="window"><div class="titlebar">${lights}<div class="title">Lists</div></div><div class="content">
     <div class="sidebar" id="names" data-role="AXScrollArea" data-title=""></div>
     <div class="pane"><h2 id="heading" data-role="AXStaticText" data-title=""></h2><div id="items"></div>
       <button class="push" id="new-item" data-role="AXButton" data-title="New item">New item</button>
       <div class="form" id="form" hidden>${field("Item", "item")}${field("Note", "note")}
         <div class="buttons"><button class="push" id="cancel" data-role="AXButton" data-title="Cancel">Cancel</button><button class="push primary" id="add" data-role="AXButton" data-title="Add">Add</button></div></div>
     </div></div></div>`,
  `var lists = { "Kitchen": [{ name: "Bread board", note: "maple, 40 cm" }], "Garden": [{ name: "Seeds", note: "tomato" }], "Gifts": [{ name: "Scarf", note: "blue" }] };
   var open = "Garden";
   function el(id) { return document.getElementById(id); }
   function set(node, text) { node.textContent = text; node.setAttribute("data-title", text); }
   function draw() {
     el("names").innerHTML = "";
     Object.keys(lists).forEach(function (name) {
       var row = document.createElement("div"); row.className = "name" + (name === open ? " chosen" : ""); row.setAttribute("data-role", "AXStaticText"); set(row, name);
       row.onclick = function () { open = name; el("form").hidden = true; draw(); }; el("names").appendChild(row);
     });
     set(el("heading"), open); el("items").innerHTML = "";
     lists[open].forEach(function (item) {
       var line = document.createElement("div"); line.className = "item"; line.setAttribute("data-role", "AXStaticText");
       set(line, item.name + (item.note ? " (" + item.note + ")" : "")); el("items").appendChild(line);
     });
   }
   function add() { var name = el("item").value.trim(); if (!name) return; lists[open].push({ name: name, note: el("note").value.trim() }); el("form").hidden = true; draw(); }
   el("new-item").onclick = function () { el("form").hidden = false; el("item").value = ""; el("note").value = ""; el("item").focus(); };
   el("cancel").onclick = function () { el("form").hidden = true; };
   el("add").onclick = add;
   ["item", "note"].forEach(function (id) { el(id).addEventListener("keydown", function (event) { if (event.key === "Enter") { event.preventDefault(); add(); } }); });
   draw();
   window.state = function () { return { open: open, lists: lists }; };`,
);

/** Receipts of two months, oldest first: date, shop, amount. */
export const receiptRows = [
  ["29 Oct", "Ink House", "15.00"],
  ["31 Oct", "Taxi Blue", "22.40"],
  ["2 Nov", "Paper Mill", "12.40"],
  ["4 Nov", "Ink House", "31.00"],
  ["5 Nov", "Corner Cafe", "7.85"],
  ["8 Nov", "Train North", "64.20"],
  ["11 Nov", "Desk Lamp Co", "18.99"],
  ["13 Nov", "Post Office", "5.50"],
  ["17 Nov", "Print Hall", "120.00"],
  ["20 Nov", "Cable Shop", "43.75"],
  ["24 Nov", "Corner Cafe", "9.10"],
  ["27 Nov", "Taxi Blue", "27.30"],
];
const tableStyle = `table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 8px 16px; border-bottom: 1px solid #e6e6e6; }
   th { background: #f3f3f3; font-weight: 600; } .wrap { flex: 1; padding: 10px 14px; overflow: hidden; }`;
/** A table of plain text with a head row: every cell an element. */
const textTable = (head: string[], rows: string[][]) =>
  `<table><tr>${head.map((name) => `<th>${name}</th>`).join("")}</tr>${rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td data-role="AXStaticText" data-title="${cell}">${cell}</td>`).join("")}</tr>`,
    )
    .join("")}</table>`;
const receipts = page(
  "Receipts",
  tableStyle,
  `<div class="window"><div class="titlebar">${lights}<div class="title">Receipts</div></div><div class="content">
     <div class="wrap">${textTable(["Date", "Shop", "Amount"], receiptRows)}</div></div></div>`,
  `window.state = function () { return {}; };`,
);

/**
 * A sheet: a click selects a cell and typing replaces what it holds. Tab
 * goes right, Return goes down to the column where the row of Tabs began, as
 * in a spreadsheet. A cell that starts with = is a formula: SUM of a range,
 * cells, numbers and + - * /.
 */
const sheets = page(
  "Expenses November",
  `.wrap { flex: 1; padding: 16px; } table { border-collapse: collapse; } th { background: #f3f3f3; font-weight: 600; width: 40px; border: 1px solid #ddd; padding: 3px; }
   td { border: 1px solid #ddd; padding: 0; } th.col { width: 200px; } input.cell { width: 200px; height: 26px; border: 0; padding: 0 6px; font: inherit; outline: 0; }
   input.cell:focus { box-shadow: inset 0 0 0 2px #0a7aff; }`,
  `<div class="window"><div class="titlebar">${lights}<div class="title">Expenses November</div></div><div class="content">
     <div class="wrap"><table id="grid"></table></div></div></div>`,
  `var cols = ["A", "B", "C"], rows = 13, raw = { A1: "Shop", B1: "Amount" }, cells = {}, tabStart = null;
   var grid = document.getElementById("grid");
   var head = document.createElement("tr"); head.appendChild(document.createElement("th"));
   cols.forEach(function (col) { var th = document.createElement("th"); th.className = "col"; th.textContent = col; head.appendChild(th); });
   grid.appendChild(head);
   function number(address) { var n = parseFloat(String(shown(address)).replace(/[$,\\s]/g, "")); return isFinite(n) ? n : 0; }
   function shown(address) {
     var text = raw[address] || "";
     if (text.charAt(0) !== "=") return text;
     var expr = text.slice(1).toUpperCase().replace(/SUM\\(([A-C])(\\d+):([A-C])(\\d+)\\)/g, function (_, c1, r1, c2, r2) {
       var sum = 0;
       for (var c = cols.indexOf(c1); c <= cols.indexOf(c2); c++) for (var r = Number(r1); r <= Number(r2); r++) if (cols[c] + r !== address) sum += number(cols[c] + r);
       return "(" + sum + ")";
     }).replace(/\\b([A-C])(\\d+)\\b/g, function (_, c, r) { return c + r === address ? "0" : "(" + number(c + r) + ")"; });
     if (!/^[\\d+\\-*\\/(). ]+$/.test(expr)) return "#ERROR";
     try { var n = Function("return (" + expr + ")")(); return isFinite(n) ? String(Math.round(n * 100) / 100) : "#ERROR"; } catch (error) { return "#ERROR"; }
   }
   function redraw() { Object.keys(cells).forEach(function (address) { if (document.activeElement !== cells[address]) cells[address].value = shown(address); }); }
   function go(col, row) { var next = cells[cols[col] + row]; if (next) { next.focus(); next.select(); } }
   for (var r = 1; r <= rows; r++) {
     var line = document.createElement("tr"), num = document.createElement("th"); num.textContent = String(r); line.appendChild(num);
     cols.forEach(function (col, c) {
       var td = document.createElement("td"), input = document.createElement("input"), address = col + r, row = r;
       input.className = "cell"; input.setAttribute("data-role", "AXCell"); input.setAttribute("data-title", address);
       input.addEventListener("mousedown", function () { tabStart = null; });
       input.addEventListener("focus", function () { input.value = raw[address] || ""; input.select(); });
       input.addEventListener("input", function () { if (input.value) raw[address] = input.value; else delete raw[address]; });
       input.addEventListener("blur", redraw);
       input.addEventListener("keydown", function (event) {
         if (event.key === "Tab") { event.preventDefault(); if (event.shiftKey) { tabStart = null; go(c - 1, row); } else { if (tabStart === null) tabStart = c; go(c + 1, row); } }
         else if (event.key === "Enter") { event.preventDefault(); var to = tabStart === null ? c : tabStart; tabStart = null; go(to, row + 1); }
         else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); tabStart = null; go(c, row + (event.key === "ArrowDown" ? 1 : -1)); }
       });
       cells[address] = input; td.appendChild(input); line.appendChild(td);
     });
     grid.appendChild(line);
   }
   redraw();
   window.state = function () {
     var values = {};
     Object.keys(raw).forEach(function (address) { values[address] = shown(address); });
     return { cells: raw, values: values };
   };`,
);

/** Messages, newest first: subject, sender, the first line, and the rest that Show the rest opens. */
const mail = [
  [
    "Offsite: sign-up",
    "Theo Park",
    "We need numbers for the caterer.",
    "Sign up by Friday 2 May on the team board.",
  ],
  [
    "Lunch on Friday?",
    "Mia Chen",
    "Shall we try the new place by the river?",
    "It opens at noon.",
  ],
  [
    "Offsite: the bus",
    "Lena Ortiz",
    "We go there together.",
    "The bus leaves at 8:15 from the main door, and comes back at 18:00.",
  ],
  [
    "Your order has shipped",
    "Market",
    "Your parcel is on its way.",
    "It arrives in 3 to 5 days.",
  ],
  [
    "Offsite: budget",
    "Ada Brook",
    "Finance answered about the money.",
    "The budget is 900 euros for the whole team, food included.",
  ],
  [
    "Printer is fixed",
    "Omar Diaz",
    "The printer on the second floor works again.",
    "Use tray 2 for labels.",
  ],
  [
    "Offsite: new date",
    "Sam Reed",
    "The hall had a clash with our first date.",
    "So the offsite moves to 14 May. Please update your calendars.",
  ],
  [
    "Team notes",
    "Ivy Laurent",
    "The notes of Monday are in the shared folder.",
    "Add your points before Thursday.",
  ],
  [
    "Offsite: the venue",
    "Lena Ortiz",
    "A short update on the place for the offsite.",
    "We booked Hall B at the river museum. It has room for the whole team.",
  ],
];
/** A mailbox: a message in the list opens it, Show the rest opens the rest of it, Flag flags it. */
const mailbox = page(
  "Mailbox",
  `.sidebar { width: 320px; border-right: 1px solid #ddd; background: #f6f6f6; } .row { padding: 10px 14px; border-bottom: 1px solid #e6e6e6; font-weight: 600; }
   .row small { display: block; font-weight: 400; color: #888; margin-top: 3px; } .row.chosen { background: #dbe8ff; } .row.flagged::after { content: " \\2691"; color: #e8590c; }
   .reader { flex: 1; padding: 22px 28px; font-size: 15px; } .reader button { margin: 8px 8px 8px 0; }`,
  `<div class="window"><div class="titlebar">${lights}<div class="title">Inbox</div></div><div class="content">
     <div class="sidebar" id="list" data-role="AXScrollArea" data-title=""></div>
     <div class="reader"><p id="empty" data-role="AXStaticText" data-title="Choose a message to read it.">Choose a message to read it.</p>
       <div id="message" hidden><h2 id="subject" data-role="AXStaticText" data-title=""></h2><p id="from" data-role="AXStaticText" data-title=""></p>
         <p id="first" data-role="AXStaticText" data-title=""></p><p id="rest" data-role="AXStaticText" data-title="" hidden></p>
         <button class="push" id="more" data-role="AXButton" data-title="Show the rest">Show the rest</button>
         <button class="push" id="flag" data-role="AXButton" data-title="Flag">Flag</button></div></div>
   </div></div>`,
  `var mail = ${JSON.stringify(mail)};
   var held = { opened: [], expanded: [], flagged: [] }, open = -1;
   function el(id) { return document.getElementById(id); }
   function set(node, text) { node.textContent = text; node.setAttribute("data-title", text); }
   function draw() {
     el("list").innerHTML = "";
     mail.forEach(function (message, index) {
       var row = document.createElement("div"), flagged = held.flagged.indexOf(message[0]) >= 0;
       row.className = "row" + (index === open ? " chosen" : "") + (flagged ? " flagged" : "");
       row.setAttribute("data-role", "AXStaticText"); row.setAttribute("data-title", message[0]); if (flagged) row.setAttribute("data-value", "Flagged");
       row.appendChild(document.createTextNode(message[0]));
       var small = document.createElement("small"); small.textContent = message[1]; row.appendChild(small);
       row.onclick = function () { show(index); }; el("list").appendChild(row);
     });
   }
   function show(index) {
     open = index; var message = mail[index]; if (held.opened.indexOf(message[0]) < 0) held.opened.push(message[0]);
     el("empty").hidden = true; el("message").hidden = false;
     set(el("subject"), message[0]); set(el("from"), "From " + message[1]); set(el("first"), message[2]); set(el("rest"), message[3]);
     el("rest").hidden = true; el("more").hidden = false;
     el("flag").setAttribute("data-title", held.flagged.indexOf(message[0]) >= 0 ? "Unflag" : "Flag"); el("flag").textContent = el("flag").getAttribute("data-title");
     draw();
   }
   el("more").onclick = function () { el("rest").hidden = false; el("more").hidden = true; var subject = mail[open][0]; if (held.expanded.indexOf(subject) < 0) held.expanded.push(subject); };
   el("flag").onclick = function () {
     var subject = mail[open][0], at = held.flagged.indexOf(subject);
     if (at >= 0) held.flagged.splice(at, 1); else held.flagged.push(subject);
     show(open); if (held.expanded.indexOf(subject) >= 0) { el("rest").hidden = false; el("more").hidden = true; }
   };
   draw();
   window.state = function () { return held; };`,
);

/** The people of two teams, as the directory lists them: name, team, extension. */
export const people = [
  ["Ada Brook", "Design", "4021"],
  ["Noah Grant", "Sales", "5012"],
  ["Lena Ortiz", "Design", "4022"],
  ["Sam Reed", "Design", "4030"],
  ["Ella Stone", "Sales", "5018"],
  ["Theo Park", "Design", "4034"],
  ["Leo Marsh", "Sales", "5020"],
  ["Mia Chen", "Design", "4041"],
  ["Zoe Hart", "Sales", "5033"],
  ["Omar Diaz", "Design", "4047"],
  ["Max Wren", "Sales", "5041"],
  ["Ivy Laurent", "Design", "4052"],
];
const directory = page(
  "Directory",
  tableStyle,
  `<div class="window"><div class="titlebar">${lights}<div class="title">Directory</div></div><div class="content">
     <div class="wrap">${textTable(["Name", "Team", "Extension"], people)}</div></div></div>`,
  `window.state = function () { return {}; };`,
);

/** Invoices: number, customer, amount, category. */
export const bookInvoices = [
  ["INV-1041", "Amber Mill", "$1,240.00", "Office"],
  ["INV-1042", "Fjord Logistics", "$5,120.00", "Travel"],
  ["INV-1043", "Cedar Works", "$2,315.75", "Office"],
  ["INV-1044", "Fjord Logistics", "$860.50", "Office"],
  ["INV-1045", "Fjord Logistics", "$410.00", "Software"],
  ["INV-1046", "Dune Trading", "$96.20", "Travel"],
  ["INV-1047", "Fjord Logistics", "$734.90", "Office"],
  ["INV-1048", "Harbor Print", "$1,999.99", "Office"],
  ["INV-1049", "Fjord Logistics", "$58.00", "Travel"],
  ["INV-1050", "Fjord Logistics", "$3,402.10", "Office"],
  ["INV-1051", "Ivory Lane", "$77.00", "Software"],
  ["INV-1052", "Fjord Logistics", "$1,150.00", "Travel"],
];
/**
 * Books of invoices: Edit opens one, its Category menu and Save change it.
 * After the third save the session ends: a sign-in stands in front of the
 * books until someone signs in again.
 */
const books = page(
  "Ledger",
  `${tableStyle}${popupStyle} a { color: #0a66d8; } .edit, .signin { margin: 50px auto; width: 380px; } .edit button { margin: 18px 8px 0 0; }
   .signin label { display: block; margin: 12px 0 4px; color: #444; } .signin input { width: 100%; height: 30px; border: 1px solid #c4c4c4; border-radius: 7px; padding: 0 9px; font: inherit; }
   .signin button { margin-top: 18px; width: 100%; height: 32px; } .problem { color: #b3261e; }`,
  `<div class="window"><div class="titlebar">${lights}<div class="title">Ledger</div></div><div class="content">
     <div class="wrap" id="books"><table id="table"><tr><th>Number</th><th>Customer</th><th>Amount</th><th>Category</th><th></th></tr></table></div>
     <div class="edit" id="edit" hidden><h2 id="heading" data-role="AXStaticText" data-title=""></h2><p id="who" data-role="AXStaticText" data-title=""></p>
       ${choose("Category", "category")}<br>
       <button class="push" id="cancel" data-role="AXButton" data-title="Cancel">Cancel</button><button class="push primary" id="save" data-role="AXButton" data-title="Save">Save</button></div>
     <div class="signin" id="signin" hidden><h2 data-role="AXStaticText" data-title="Your session ended">Your session ended</h2>
       <p data-role="AXStaticText" data-title="Sign in again to go on.">Sign in again to go on.</p>
       <label>Email</label><input id="email" data-role="AXTextField" data-title="Email">
       <label>Password</label><input id="password" type="password" data-role="AXSecureTextField" data-title="Password">
       <button class="push primary" id="go" data-role="AXButton" data-title="Sign in">Sign in</button>${problemLine}</div>
   </div></div>`,
  `${popupScript}
   var invoices = ${JSON.stringify(bookInvoices)};
   var held = { categories: {}, saves: 0, signIns: 0, email: "", password: "", changes: [] }, editing = null, chosen = "";
   invoices.forEach(function (row) { held.categories[row[0]] = row[3]; });
   function el(id) { return document.getElementById(id); }
   function view(id) { ["books", "edit", "signin"].forEach(function (name) { el(name).hidden = name !== id; }); }
   var showCategory = popup(el("category"), ["Freight", "Office", "Software", "Travel"], function (value) { chosen = value; });
   function draw() {
     var table = el("table"); while (table.rows.length > 1) table.deleteRow(1);
     invoices.forEach(function (row) {
       var line = table.insertRow();
       [row[0], row[1], row[2], held.categories[row[0]]].forEach(function (text) { var cell = line.insertCell(); cell.setAttribute("data-role", "AXStaticText"); set(cell, text); });
       var link = document.createElement("a"); link.href = "#"; link.setAttribute("data-role", "AXLink"); set(link, "Edit");
       link.onclick = function (event) { event.preventDefault(); edit(row); }; line.insertCell().appendChild(link);
     });
   }
   function edit(row) { editing = row; chosen = held.categories[row[0]]; set(el("heading"), "Invoice " + row[0]); set(el("who"), row[1] + ", " + row[2]); showCategory(chosen); view("edit"); }
   el("cancel").onclick = function () { view("books"); };
   el("save").onclick = function () {
     if (chosen !== held.categories[editing[0]]) held.changes.push(editing[0]);
     held.categories[editing[0]] = chosen; held.saves += 1; draw();
     view(held.saves === 3 ? "signin" : "books");
   };
   el("go").onclick = function () {
     var email = el("email").value.trim(), password = el("password").value;
     if (!email || !password) return set(document.querySelector("#signin .problem"), "Give the email and the password.");
     held.email = email; held.password = password; held.signIns += 1; view("books");
   };
   draw();
   window.state = function () { return held; };`,
);

/** The people of the rota, A to Z by first name, and the three that another person adds while the request runs. */
export const rotaPeople = [
  "Ada Brook",
  "Ella Stone",
  "Finn Shaw",
  "Ivy Laurent",
  "Lena Ortiz",
  "Leo Marsh",
  "Max Wren",
  "Mia Chen",
  "Noah Grant",
  "Omar Diaz",
  "Ruth Vale",
  "Sam Reed",
  "Theo Park",
  "Zoe Hart",
];
export const rotaNewcomers = ["Kai Moss", "Bea Lund", "Dan Holt"];
/**
 * A rota: a person in the list opens their shift, the Shift menu and Save
 * change it. `window.sync()` is another person's change: three people more,
 * and the list sorted by last name, with a banner that says so.
 */
const rota = page(
  "Rota",
  `${popupStyle} .list { width: 420px; border-right: 1px solid #ddd; overflow: hidden; } .person { display: flex; justify-content: space-between; padding: 7px 16px; border-bottom: 1px solid #eee; }
   .person.chosen { background: #dbe8ff; } .shift { color: #666; } .detail { flex: 1; padding: 70px 40px 30px; } .detail button.push { margin: 18px 8px 0 0; }
   .banner { position: absolute; left: 440px; top: 12px; right: 20px; padding: 10px 14px; background: #fff4cc; border: 1px solid #e6cf7a; border-radius: 8px; }`,
  `<div class="window"><div class="titlebar">${lights}<div class="title">Rota</div></div><div class="content">
     <div class="list" id="list"></div>
     <div class="detail"><p id="hint" data-role="AXStaticText" data-title="Choose a person to change their shift.">Choose a person to change their shift.</p>
       <div id="form" hidden><h2 id="who" data-role="AXStaticText" data-title=""></h2>${choose("Shift", "shift")}<br>
         <button class="push" id="cancel" data-role="AXButton" data-title="Cancel">Cancel</button><button class="push primary" id="save" data-role="AXButton" data-title="Save">Save</button></div></div>
     <div class="banner" id="banner" hidden data-role="AXStaticText" data-title="Another person changed the rota. The list is now sorted by last name.">Another person changed the rota. The list is now sorted by last name.</div>
   </div></div>`,
  `${popupScript}
   var people = ${JSON.stringify(rotaPeople)}, newcomers = ${JSON.stringify(rotaNewcomers)};
   var held = { shifts: {}, saves: 0, synced: false, changes: [] }, open = "", chosen = "";
   people.forEach(function (name) { held.shifts[name] = "Weekday"; });
   function el(id) { return document.getElementById(id); }
   var showShift = popup(el("shift"), ["Weekday", "Weekend", "Nights"], function (value) { chosen = value; });
   function draw() {
     el("list").innerHTML = "";
     people.forEach(function (name) {
       var row = document.createElement("div"); row.className = "person" + (name === open ? " chosen" : "");
       var label = document.createElement("span"); label.setAttribute("data-role", "AXStaticText"); set(label, name);
       var shift = document.createElement("span"); shift.className = "shift"; shift.setAttribute("data-role", "AXStaticText"); set(shift, held.shifts[name]);
       row.appendChild(label); row.appendChild(shift); row.onclick = function () { pick(name); }; el("list").appendChild(row);
     });
   }
   function pick(name) { open = name; chosen = held.shifts[name]; set(el("who"), name); showShift(chosen); el("hint").hidden = true; el("form").hidden = false; draw(); }
   function close() { open = ""; el("form").hidden = true; el("hint").hidden = false; draw(); }
   el("cancel").onclick = close;
   el("save").onclick = function () { if (chosen !== held.shifts[open]) held.changes.push(open); held.shifts[open] = chosen; held.saves += 1; close(); };
   window.sync = function () {
     if (held.synced) return;
     held.synced = true;
     newcomers.forEach(function (name) { people.push(name); held.shifts[name] = "Weekday"; });
     var last = function (name) { return name.split(" ").slice(-1)[0]; };
     people.sort(function (a, b) { return last(a) < last(b) ? -1 : last(a) > last(b) ? 1 : 0; });
     el("banner").hidden = false; draw();
   };
   draw();
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
  // The apps of the long requests.
  lease: {
    app: {
      name: "Homes",
      bundleId: "com.example.homes",
      window: "Lease application",
    },
    html: lease,
  },
  market: {
    app: { name: "Market", bundleId: "com.example.market", window: "Market" },
    html: market,
  },
  lists: {
    app: { name: "Lists", bundleId: "com.example.lists", window: "Lists" },
    html: lists,
  },
  receipts: {
    app: {
      name: "Receipts",
      bundleId: "com.example.receipts",
      window: "Receipts",
    },
    html: receipts,
  },
  sheets: {
    app: {
      name: "Sheets",
      bundleId: "com.example.sheets",
      window: "Expenses November",
    },
    html: sheets,
  },
  mailbox: {
    app: { name: "Mailbox", bundleId: "com.example.mailbox", window: "Inbox" },
    html: mailbox,
  },
  directory: {
    app: {
      name: "Directory",
      bundleId: "com.example.directory",
      window: "Directory",
    },
    html: directory,
  },
  books: {
    app: { name: "Ledger", bundleId: "com.example.ledger", window: "Ledger" },
    html: books,
  },
  rota: {
    app: { name: "Rota", bundleId: "com.example.rota", window: "Rota" },
    html: rota,
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
