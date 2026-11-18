import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TaskAudioInspectorClient,
  type TaskAudioInspectorOptions,
} from "../cli/task-audio-inspector-client.js";

const clients: TaskAudioInspectorClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});
function child(
  body: string,
  options: Partial<TaskAudioInspectorOptions> = {},
  prefix = "",
) {
  const client = new TaskAudioInspectorClient({
    command: process.execPath,
    args: [
      "-e",
      `${prefix}\nconst readline=require('node:readline');
process.stdout.write(JSON.stringify({ready:true,version:1})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line); ${body}
});`,
    ],
    timeoutMs: 500,
    startupTimeoutMs: 2000,
    closeGraceMs: 50,
    ...options,
  });
  clients.push(client);
  return client;
}
const reply =
  "process.stdout.write(JSON.stringify({id:message.id,ok:true,value:message.payload})+'\\n');";

describe("persistent read-only task audio inspector client", () => {
  it("requires explicit startup and serializes multiple round trips over one child", async () => {
    const client = child(reply);
    await expect(client.request({ before: "start" })).rejects.toThrow(
      "explicit startup",
    );
    await client.start();
    const payloads = [{ n: 1 }, { n: 2, text: "Unicode café" }, [3, 4]];
    expect(
      await Promise.all(payloads.map((value) => client.request(value))),
    ).toEqual(payloads);
  });
  it("retains a healthy channel after the exact fixed refusal", async () => {
    const client =
      child(`process.stdout.write(JSON.stringify(message.payload.refuse
      ? {id:message.id,ok:false,error:'inspection_failed'}
      : {id:message.id,ok:true,value:'status'})+'\\n');`);
    await client.start();
    await expect(client.request({ refuse: true })).rejects.toThrow(
      "refused the read-only",
    );
    expect(await client.request({})).toBe("status");
  });
  it.each([
    "process.stdout.write(JSON.stringify({id:'foreign',ok:true,value:{}})+'\\n');",
    "process.stdout.write('not json\\n');",
    "process.stdout.write(JSON.stringify({id:message.id,ok:true,value:{},extra:true})+'\\n');",
    "process.stdout.write(JSON.stringify({id:message.id,ok:false,error:'PRIVATE_PEER_DETAIL'})+'\\n');",
    "process.stdout.write(JSON.stringify({ready:true,version:1})+'\\n');",
  ])("poisons every pending request on protocol mismatch", async (body) => {
    const client = child(body);
    await client.start();
    const results = await Promise.allSettled([
      client.request({ n: 1 }),
      client.request({ n: 2 }),
    ]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(JSON.stringify(results)).not.toContain("PRIVATE_PEER_DETAIL");
    await client.close();
    await expect(client.request({})).rejects.toThrow();
  });
  it("rejects duplicate response IDs instead of associating them with later work", async () => {
    const client = child(`${reply} ${reply}`);
    await client.start();
    const first = client.request({ n: 1 }),
      second = client.request({ n: 2 });
    expect(await first).toEqual({ n: 1 });
    await expect(second).rejects.toThrow("identity or schema");
    await client.close();
  });
  it("bounds response lines even without a newline", async () => {
    const client = child("process.stdout.write('x'.repeat(1024));", {
      maxLineBytes: 128,
    });
    await client.start();
    await expect(client.request({})).rejects.toThrow("exceeds its bound");
    await client.close();
  });
  it("bounds pending work and rejects oversized payloads without submitting them", async () => {
    const client = child(`setTimeout(()=>{${reply}},50);`, {
      maxPending: 1,
      maxLineBytes: 128,
    });
    await client.start();
    await expect(client.request({ text: "x".repeat(200) })).rejects.toThrow(
      "payload",
    );
    const first = client.request({ n: 1 });
    await expect(client.request({ n: 2 })).rejects.toThrow("limit");
    expect(await first).toEqual({ n: 1 });
  });
  it("does not send during startup or retry a timed-out request", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "clawdtime-inspector-test-"),
    );
    const path = join(directory, "count");
    const prefix = `const fs=require('node:fs'); const countFile=${JSON.stringify(path)}; fs.writeFileSync(countFile,'0');`;
    const client = child(
      "fs.writeFileSync(countFile,String(Number(fs.readFileSync(countFile,'utf8'))+1));",
      { timeoutMs: 50 },
      prefix,
    );
    try {
      await client.start();
      expect(await readFile(path, "utf8")).toBe("0");
      await expect(client.request({ inspect: true })).rejects.toThrow(
        "timed out; no retry",
      );
      await client.close();
      expect(await readFile(path, "utf8")).toBe("1");
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("rejects all pending requests on child exit", async () => {
    const client = child(
      "process.stderr.write('PRIVATE_STDERR');process.exit(7);",
    );
    await client.start();
    const results = await Promise.allSettled([
      client.request({}),
      client.request({}),
    ]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    for (const result of results)
      if (result.status === "rejected")
        expect(result.reason.message).not.toContain("PRIVATE_STDERR");
    await client.close();
  });
  it("joins one idempotent close and kills a child ignoring TERM", async () => {
    const client = child(
      "",
      {},
      "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);",
    );
    await client.start();
    const pending = client.request({});
    const closed = client.close();
    expect(client.close()).toBe(closed);
    await expect(pending).rejects.toThrow("closed");
    await closed;
  });
  it.each([
    "process.stdout.write('wrong\\n');setInterval(()=>{},1000);",
    "setInterval(()=>{},1000);",
  ])(
    "refuses missing or malformed readiness without sending requests",
    async (source) => {
      const client = new TaskAudioInspectorClient({
        command: process.execPath,
        args: ["-e", source],
        startupTimeoutMs: 80,
        closeGraceMs: 30,
      });
      clients.push(client);
      await expect(client.start()).rejects.toThrow(
        /readiness|handshake|malformed protocol/,
      );
      await client.close();
    },
  );
  it("handles failed spawn without exposing command details", async () => {
    const client = new TaskAudioInspectorClient({
      command: "/synthetic-missing-inspector",
      startupTimeoutMs: 100,
      closeGraceMs: 30,
    });
    clients.push(client);
    await expect(client.start()).rejects.toThrow("process unavailable");
    await client.close();
  });
});
