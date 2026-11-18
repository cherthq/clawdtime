import { mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
const parent = resolve(process.argv[2] ?? "");
if (!process.argv[2])
  throw new Error("Provide a new disposable fixture directory.");
mkdirSync(parent, { mode: 0o700 });
const project = join(parent, "project");
mkdirSync(project, { mode: 0o700 });
writeFileSync(
  join(project, "app.mjs"),
  `export function filterTasks(tasks, query) { return tasks; }\nexport function renderTasks(tasks, query) { return '<ul>' + filterTasks(tasks, query).map(t => '<li>' + t.title + '</li>').join('') + '</ul>'; }\n`,
);
writeFileSync(
  join(project, "index.html"),
  `<!doctype html><html><meta charset="utf-8"><title>ClawdTime task fixture</title><body><h1>Tasks</h1><label>Filter <input id="filter"></label><main id="tasks"></main><script type="module">import {renderTasks} from './app.mjs'; const items=[{title:'Write release notes'},{title:'Review filter'}]; const input=document.querySelector('#filter'); const render=()=>document.querySelector('#tasks').innerHTML=renderTasks(items,input.value); input.addEventListener('input',render); document.addEventListener('click',e=>{if(e.target.closest('[data-clear-filters]')){input.value='';render();}});render();</script></body></html>`,
);
writeFileSync(
  join(project, "README.md"),
  "Disposable coding-demo fixture. app.mjs exports filterTasks(tasks, query) and renderTasks(tasks, query); task objects have a title. Do not start servers or background jobs. Preserve exported API and HTML input wiring. Test evidence is supplied independently outside the worker workspace. The empty-state choice is deliberately unresolved for the demo.\n",
);
const root = realpathSync(project);
const checker = join(realpathSync(parent), "verify.mjs");
writeFileSync(
  checker,
  `import assert from 'node:assert/strict';\nimport {pathToFileURL} from 'node:url';\nconst {filterTasks,renderTasks}=await import(pathToFileURL(process.argv[2]+'/app.mjs').href);\nconst tasks=[{title:'Write release notes'},{title:'Review filter'}];\nassert.deepEqual(filterTasks(tasks,'RELEASE'),[tasks[0]],'case insensitive substring filter');\nassert.deepEqual(filterTasks(tasks,''),tasks,'clear filter restores tasks');\nassert.deepEqual(filterTasks(tasks,'missing'),[],'no match returns no tasks');\nconst html=renderTasks(tasks,'missing');\nassert.match(html,/No tasks/i,'visible empty-state text');\nassert.match(html,/<button[^>]*data-clear-filters[^>]*>Clear filters<\\/button>/i,'working clear-filter button hook');\nassert.ok(!renderTasks(tasks,'release').includes('Review filter'),'render only matching rows');\nconsole.log('Six independent assertions passed');\n`,
);
writeFileSync(
  join(parent, "checks.json"),
  JSON.stringify(
    [
      {
        name: "Filter and empty-state assertions (deliberate demo fixture)",
        command: [process.execPath, checker, root],
      },
      {
        name: "JavaScript build syntax",
        command: [process.execPath, "--check", join(root, "app.mjs")],
      },
    ],
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    project: root,
    checks: join(realpathSync(parent), "checks.json"),
    fixture: true,
    seededDecision:
      "Empty-state behavior is deliberately unresolved; first-run checks may fail until a human selects it.",
  }),
);
