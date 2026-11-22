const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { inspectPinnedProvider, RETENTION_PIN } from "./provider-retention.mjs";
const guardURL = new URL("./provider-retention.mjs", import.meta.url).href;
const migrationURL = new URL(
  "./provider-retention-migrate.mjs",
  import.meta.url,
).href;
const binding = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(join(os.tmpdir(), "clawdtime-retention-test-")),
  );
  const home = join(root, "home");
  fs.mkdirSync(join(home, "dev", binding), { recursive: true, mode: 0o700 });
  const dir = join(home, "dev", binding),
    journal = join(dir, "journal.json"),
    credential = dir + ".credentials.json";
  fs.writeFileSync(
    journal,
    JSON.stringify({
      schema_version: 2,
      mode: "byor",
      scope: {
        project_id: "synthetic-project",
        line_id: "synthetic-line",
        binding_id: binding,
        session_mode: "byor",
      },
      entries: {},
      receipts: {},
    }),
    { mode: 0o600 },
  );
  fs.writeFileSync(credential, "synthetic-token-never-provider", {
    mode: 0o600,
  });
  return { root, home, dir, journal, credential };
}
test("real pre-existing named fs import preserves only scoped cleanup and original inode/bytes", () => {
  const f = fixture();
  try {
    const before = fs.readFileSync(f.journal),
      inode = fs.statSync(f.journal).ino;
    const command = join(f.root, "command.mjs");
    fs.writeFileSync(
      command,
      `import {rmSync} from 'node:fs';export function cleanup(paths){for(const p of paths)rmSync(p,{recursive:true,force:true});}`,
    );
    const unrelated = join(f.root, "unrelated");
    fs.writeFileSync(unrelated, "synthetic");
    const script = `import {cleanup} from ${JSON.stringify(pathToFileURL(command).href)};import {installScopedRetentionGuard} from ${JSON.stringify(guardURL)};installScopedRetentionGuard(${JSON.stringify({ chertHome: f.home, projectId: "synthetic-project", lineId: "synthetic-line", commandFile: command })});cleanup(${JSON.stringify([f.credential, f.dir, unrelated])});`;
    execFileSync(process.execPath, ["--input-type=module", "-e", script]);
    assert.deepEqual(fs.readFileSync(f.journal), before);
    assert.equal(fs.statSync(f.journal).ino, inode);
    assert.equal(
      fs.readFileSync(f.credential, "utf8"),
      "synthetic-token-never-provider",
    );
    assert.equal(fs.existsSync(unrelated), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
test("wrong scope fails closed instead of deleting original records", () => {
  const f = fixture();
  try {
    const command = join(f.root, "command.mjs");
    fs.writeFileSync(
      command,
      `import {rmSync} from 'node:fs';export function cleanup(p){rmSync(p,{recursive:true,force:true});}`,
    );
    const script = `import {cleanup} from ${JSON.stringify(pathToFileURL(command).href)};import {installScopedRetentionGuard} from ${JSON.stringify(guardURL)};installScopedRetentionGuard(${JSON.stringify({ chertHome: f.home, projectId: "other-project", lineId: "synthetic-line", commandFile: command })});try{cleanup(${JSON.stringify(f.dir)});process.exitCode=2}catch(e){if(e.message!=='retention_scope_mismatch')throw e}`;
    execFileSync(process.execPath, ["--input-type=module", "-e", script]);
    assert.equal(fs.existsSync(f.journal), true);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
test("unrelated caller retains native rmSync behavior", () => {
  const f = fixture();
  try {
    execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      `import {rmSync} from 'node:fs';import {installScopedRetentionGuard} from ${JSON.stringify(guardURL)};installScopedRetentionGuard(${JSON.stringify({ chertHome: f.home, projectId: "synthetic-project", lineId: "synthetic-line", commandFile: join(f.root, "never-called.mjs") })});rmSync(${JSON.stringify(f.dir)},{recursive:true,force:true});`,
    ]);
    assert.equal(fs.existsSync(f.dir), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
test("unsupported provider versions fail before hooks", () => {
  const root = fs.mkdtempSync(join(os.tmpdir(), "clawdtime-provider-pin-"));
  try {
    fs.writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ version: "0.1.0-beta.22" }),
    );
    assert.throws(() => inspectPinnedProvider(root), /version_mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
// Local executable qualification: never launches chert or makes a provider request.
const installed = process.execPath.replace(
  /\/bin\/node$/,
  "/lib/node_modules/@trychert/facetime",
);
test(
  "controlled inspector resolves bare argv0 from mapped executable, installs, acknowledges and closes debugger",
  {
    skip:
      process.version !== RETENTION_PIN.nodeVersion ||
      !fs.existsSync(join(installed, "package.json")),
  },
  async () => {
    const f = fixture();
    let child;
    try {
      inspectPinnedProvider(installed);
      const receipts = join(f.root, "receipts");
      fs.mkdirSync(receipts, { mode: 0o700 });
      const config = join(f.root, "retention.json");
      fs.writeFileSync(
        config,
        JSON.stringify({
          version: 1,
          providerRoot: installed,
          chertHome: f.home,
          projectId: "synthetic-project",
          lineId: "synthetic-line",
          receiptDirectory: receipts,
        }),
        { mode: 0o600 },
      );
      const runner = join(f.root, "chert-fixture.mjs");
      fs.writeFileSync(
        runner,
        `console.log('ready');setInterval(()=>{},1000);await new Promise(()=>{});`,
      );
      child = spawn(
        process.execPath,
        [
          "--import",
          runner,
          join(installed, "dist/src/cli/main.js"),
          "dev",
          "synthetic",
        ],
        {
          argv0: "node",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      await new Promise((r, j) => {
        child.stdout.once("data", r);
        child.once("error", j);
      });
      assert.equal(
        execFileSync("/bin/ps", ["-p", String(child.pid), "-o", "comm="], {
          encoding: "utf8",
        }).trim(),
        "node",
      );
      const { describeRetentionTarget, migrateRetention } = await import(
        migrationURL
      );
      const expected = join(f.root, "expected.json");
      fs.writeFileSync(
        expected,
        JSON.stringify(describeRetentionTarget(config, child.pid)),
        { mode: 0o600 },
      );
      const collision = net.createServer();
      await new Promise((resolve, reject) => {
        collision.once("error", reject);
        collision.listen(9229, "127.0.0.1", resolve);
      });
      try {
        await assert.rejects(
          migrateRetention(config, expected),
          /inspector_port_occupied/,
        );
      } finally {
        await new Promise((r) => collision.close(r));
      }
      const receiptPath = join(receipts, `${child.pid}.json`);
      fs.writeFileSync(receiptPath, "{}", { mode: 0o600 });
      await assert.rejects(
        migrateRetention(config, expected),
        /inspector_evaluation_failed/,
      );
      fs.unlinkSync(receiptPath);
      const result = await migrateRetention(config, expected);
      assert.deepEqual(result, {
        installed: true,
        inspectorClosed: true,
        pid: child.pid,
      });
      assert.equal(
        JSON.parse(fs.readFileSync(join(receipts, `${child.pid}.json`), "utf8"))
          .capability,
        "clawdtime-retention-v1",
      );
    } finally {
      if (child) {
        child.kill("SIGTERM");
        await new Promise((r) => child.once("exit", r));
      }
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  },
);
test(
  "pinned provider runDev uses original drain/revoke then retains original journal and credentials",
  { skip: !fs.existsSync(join(installed, "package.json")) },
  () => {
    const f = fixture();
    try {
      fs.rmSync(f.credential); // runDev requires exclusive creation of its synthetic credentials file.
      const script = `
 import {runDev} from ${JSON.stringify(pathToFileURL(join(installed, "dist/src/dev/command.js")).href)};
 import fs from 'node:fs';
 import {installScopedRetentionGuard} from ${JSON.stringify(guardURL)};
 globalThis.fetch=()=>{throw Error('network_forbidden')};
 const scope={project_id:'synthetic-project',line_id:'synthetic-line',binding_id:${JSON.stringify(binding)},binding_epoch:1,instance_id:'synthetic-instance',connection_generation:0,session_mode:'byor'};
 const effects=[];
 const control={projects:async()=>[{id:scope.project_id,name:'Synthetic',role:'owner'}],lines:async()=>[{id:scope.line_id,status:'available',inbound_policy:'customer_decides',default_assistant_id:null,current_call_id:null,assignment_generation:1}],bindings:async()=>[],enroll:async()=>({scope,credentials:{connection:'synthetic-connection',recovery:'synthetic-recovery'}}),activate:async()=>effects.push('activate'),drain:async()=>effects.push('drain'),revoke:async()=>effects.push('revoke')};
 installScopedRetentionGuard({chertHome:${JSON.stringify(f.home)},projectId:scope.project_id,lineId:scope.line_id,commandFile:${JSON.stringify(join(installed, "dist/src/dev/command.js"))}});
 const records=[];
 const code=await runDev({agent:'synthetic-agent',project:scope.project_id,controlOrigin:'https://example.invalid',relayOrigin:'https://example.invalid',livekitUrl:'wss://example.invalid',apiKey:'synthetic',apiSecret:'synthetic',prewarm:false},{control,home:${JSON.stringify(f.home)},env:{},signal:new AbortController().signal,emit:r=>records.push(r),api:{},run:async(config,env,signal,observe)=>{observe({code:'runtime_stopped',retained:0});return 0}});
 if(code!==0||effects.join(',')!=='activate,drain,revoke'||records.at(-1).code!=='dev_stopped'||records.at(-1).retained!==0)throw Error('release_contract_failed');
 `;
      const before = fs.readFileSync(f.journal),
        inode = fs.statSync(f.journal).ino;
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        timeout: 10000,
      });
      assert.deepEqual(fs.readFileSync(f.journal), before);
      assert.equal(fs.statSync(f.journal).ino, inode);
      assert.equal(fs.existsSync(f.credential), true);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  },
);
test("zero-call cleanup requires exact process binding authorization and preserves credentials", () => {
  const f = fixture();
  try {
    fs.rmSync(f.journal);
    const receipts = join(f.root, "receipts");
    fs.mkdirSync(receipts, { mode: 0o700 });
    const command = join(f.root, "command.mjs");
    fs.writeFileSync(
      command,
      `import {rmSync} from 'node:fs';export function cleanup(paths){for(const p of paths)rmSync(p,{recursive:true,force:true});}`,
    );
    const script = `import fs from 'node:fs';import {cleanup} from ${JSON.stringify(pathToFileURL(command).href)};import {installScopedRetentionGuard,processIdentity} from ${JSON.stringify(guardURL)};installScopedRetentionGuard(${JSON.stringify({ chertHome: f.home, projectId: "synthetic-project", lineId: "synthetic-line", commandFile: command, receiptDirectory: receipts })});const paths=${JSON.stringify([f.credential, f.dir])};let refused=false;try{cleanup(paths)}catch{refused=true}if(!refused)throw Error('missing authorization accepted');fs.writeFileSync(${JSON.stringify(receipts)}+'/'+process.pid+'.binding.json',JSON.stringify({...processIdentity(),scope:{project_id:'synthetic-project',line_id:'synthetic-line',binding_id:${JSON.stringify(binding)},session_mode:'byor'}}),{mode:0o600});cleanup(paths);`;
    execFileSync(process.execPath, ["--input-type=module", "-e", script]);
    assert.equal(fs.existsSync(f.credential), true);
    assert.equal(fs.existsSync(f.dir), true);
    assert.equal(fs.existsSync(f.journal), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
test(
  "new claim refuses incomplete original journal using pinned provider completion predicate",
  { skip: !fs.existsSync(join(installed, "package.json")) },
  async () => {
    const f = fixture();
    try {
      const { assertRetainedJournalsClean } = await import(guardURL);
      const receipts = join(f.root, "receipts");
      fs.mkdirSync(receipts, { mode: 0o700 });
      const config = join(f.root, "retention.json");
      fs.writeFileSync(
        config,
        JSON.stringify({
          version: 1,
          providerRoot: installed,
          chertHome: f.home,
          projectId: "synthetic-project",
          lineId: "synthetic-line",
          receiptDirectory: receipts,
        }),
        { mode: 0o600 },
      );
      const scope = {
        project_id: "synthetic-project",
        line_id: "synthetic-line",
        binding_id: binding,
        binding_epoch: 1,
        instance_id: "synthetic-instance",
        connection_generation: 0,
        session_mode: "byor",
      };
      const entry = {
        owner: {
          ...scope,
          call_id: "synthetic-call",
          request_id: "synthetic-request",
        },
        digest: "a".repeat(64),
        call: {
          operation_id: "synthetic-op",
          project_id: scope.project_id,
          line_id: scope.line_id,
          call_id: "synthetic-call",
          request_id: "synthetic-request",
          deadline_at: 1,
          prepare_deadline_at: 1,
          maximum_session_expires_at: 1,
          media: { audio: true, video: false },
        },
        invoked: true,
        acceptance: "accept",
        authoritative_terminal: true,
        version: 1,
        cancel_requested: false,
        settled: true,
        cleanup: "clean",
        events: [
          {
            event: { event_id: "synthetic-event", transition: "ended" },
            acknowledged: true,
          },
        ],
      };
      const journal = {
        schema_version: 2,
        mode: "byor",
        handler: { id: "synthetic", module: "/synthetic" },
        scope,
        entries: { synthetic: entry },
        receipts: { synthetic: "synthetic" },
      };
      const write = () => fs.writeFileSync(f.journal, JSON.stringify(journal));
      write();
      assert.doesNotThrow(() => assertRetainedJournalsClean(config));
      for (const field of [
        "authoritative_terminal",
        "settled",
        "cleanup",
        "events",
      ]) {
        const original = entry[field];
        entry[field] =
          field === "cleanup"
            ? "unknown"
            : field === "events"
              ? [{ ...entry.events[0], acknowledged: false }]
              : false;
        write();
        assert.throws(
          () => assertRetainedJournalsClean(config),
          /original_work_unfinished/,
        );
        entry[field] = original;
      }
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  },
);
