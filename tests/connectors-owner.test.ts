import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computerCli } from "../cli/computer.js";
import { agentsCli } from "../cli/agents.js";
import {
  normalizePhone,
  writeChertKey,
  writeOwner,
} from "../connectors/shared/owner.js";
import { textSettings } from "../connectors/agents/texts.js";
import { ownerTextPort } from "../connectors/computer/reach.js";
import { fakeSystem } from "./connectors-agents-fixture.js";

const project = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const lineId = "fedcbafe-dcba-4fed-8cba-fedcbafedcba";
const phone = "+15550100123";
const key = "ftk_fixture_project_key_abcdefghij";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("what clawdtime connect stores, in the text channel and the reach", () => {
  const stateFolder = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "clawdtime-owner-")));
    roots.push(root);
    return root;
  };

  it("fills what the environment does not have, and the environment wins", () => {
    const root = stateFolder();
    expect(textSettings({}, root)).toEqual({
      missing: ["CHERT_API_KEY", "CHERT_PROJECT_ID", "CLAWDTIME_OWNER_PHONE"],
    });
    writeOwner(root, { version: 1, phone, consent: { answer: "yes", at: 1 } });
    writeChertKey(root, { version: 1, projectId: project, apiKey: key });
    expect(textSettings({}, root)).toEqual({
      settings: {
        base: "https://app.trychert.com/api/v1",
        key,
        project,
        owner: phone,
        line: null,
        word: null,
      },
    });
    // A variable of the environment wins.
    const other = "11111111-2222-4333-8444-555555555555";
    expect(
      textSettings(
        {
          CHERT_API_KEY: "ftk_from_environment",
          CHERT_PROJECT_ID: other,
          CLAWDTIME_OWNER_PHONE: "+15550100999",
        },
        root,
      ),
    ).toMatchObject({
      settings: {
        key: "ftk_from_environment",
        project: other,
        owner: "+15550100999",
      },
    });
    // The stored key never goes with another project.
    expect(textSettings({ CHERT_PROJECT_ID: other }, root)).toEqual({
      missing: ["CHERT_API_KEY"],
    });
    // Without the state folder, nothing stored is read: the old behavior.
    expect(textSettings({})).toEqual({
      missing: ["CHERT_API_KEY", "CHERT_PROJECT_ID", "CLAWDTIME_OWNER_PHONE"],
    });
    expect(normalizePhone("0044 7700 900123")).toBe("+447700900123");
    expect(normalizePhone("555 0100")).toBeNull();
  });

  it("the reach texts the stored number only with the owner's yes", async () => {
    const root = stateFolder();
    writeChertKey(root, { version: 1, projectId: project, apiKey: key });
    writeOwner(root, { version: 1, phone });
    expect(ownerTextPort({}, root).readiness()).toEqual({
      ready: false,
      reason: "no_consent",
    });
    writeOwner(root, { version: 1, phone, consent: { answer: "yes", at: 1 } });
    expect(ownerTextPort({}, root).readiness()).toEqual({
      ready: false,
      reason: "no_line",
    });
    const sent: { url: string; body: unknown; auth: string }[] = [];
    const port = ownerTextPort({ CHERT_LINE_ID: lineId }, root, (async (
      url: string | URL,
      init: RequestInit = {},
    ) => {
      sent.push({
        url: String(url),
        body: JSON.parse(String(init.body)),
        auth: (init.headers as Record<string, string>).authorization ?? "",
      });
      return new Response(JSON.stringify({ data: { state: "queued" } }), {
        status: 200,
      });
    }) as typeof fetch);
    expect(port.readiness()).toEqual({ ready: true, reason: "ready" });
    expect(await port.send("clawdtime-reach:fixture", "Hello")).toBe("sent");
    expect(sent[0]!.auth).toBe(`Bearer ${key}`);
    expect(sent[0]!.body).toEqual({
      line_id: lineId,
      recipient: phone,
      text: "Hello",
    });
    // With a stored yes, a text goes only to the number that the yes is for.
    const other = ownerTextPort(
      { CLAWDTIME_OWNER_PHONE: "+15550100999", CHERT_LINE_ID: lineId },
      root,
      (async (url: string | URL, init: RequestInit = {}) => {
        sent.push({
          url: String(url),
          body: JSON.parse(String(init.body)),
          auth: "",
        });
        return new Response(JSON.stringify({ data: { state: "queued" } }), {
          status: 200,
        });
      }) as typeof fetch,
    );
    expect(await other.send("clawdtime-reach:other", "Hello")).toBe("sent");
    expect(sent[1]!.body).toMatchObject({ recipient: phone });
    // A stored number without a yes, or with a no, gets no text, also when
    // the environment has a number.
    for (const consent of [undefined, { answer: "no" as const, at: 2 }]) {
      writeOwner(root, { version: 1, phone, ...(consent ? { consent } : {}) });
      expect(
        ownerTextPort(
          { CLAWDTIME_OWNER_PHONE: phone, CHERT_LINE_ID: lineId },
          root,
        ).readiness(),
      ).toEqual({ ready: false, reason: "no_consent" });
    }
    // Without anything stored, the number of the environment is texted as before.
    const bare = stateFolder();
    expect(
      ownerTextPort(
        {
          CLAWDTIME_OWNER_PHONE: phone,
          CHERT_LINE_ID: lineId,
          CHERT_API_KEY: key,
          CHERT_PROJECT_ID: project,
        },
        bare,
      ).readiness(),
    ).toEqual({ ready: true, reason: "ready" });
  });

  it("clawdtime texts check uses the stored number and key", async () => {
    const root = stateFolder();
    writeChertKey(root, { version: 1, projectId: project, apiKey: key });
    writeOwner(root, { version: 1, phone, consent: { answer: "yes", at: 1 } });
    const lines: string[] = [];
    const seen: string[] = [];
    await agentsCli(["--supervisor", "texts", "check"], {
      system: fakeSystem({
        now: Date.UTC(2026, 10, 26),
        home: root,
        env: { CLAWDTIME_CONFIG_HOME: root },
      }),
      runner: async () => ({ status: 0, stdout: "" }),
      print: (text: string) => lines.push(text),
      model: null,
      request: (async (url: string | URL, init: RequestInit = {}) => {
        seen.push(
          `${init.method ?? "GET"} ${String(url)} ${(init.headers as Record<string, string>)["x-chert-project-id"]}`,
        );
        return new Response(JSON.stringify({ data: { items: [] } }), {
          status: 200,
        });
      }) as typeof fetch,
    });
    expect(lines.at(-1)).toContain("The key works");
    expect(seen).toEqual([
      `GET https://app.trychert.com/api/v1/shared-messages ${project}`,
    ]);
  });

  it("the doctor says why calls and texts cannot reach you", async () => {
    const root = stateFolder();
    mkdirSync(join(root, "computer"), { mode: 0o700 });
    writeFileSync(
      join(root, "computer", "reach.json"),
      JSON.stringify({
        version: 1,
        items: [],
        readiness: {
          at: Date.now(),
          calls: { ready: false, reason: "outbound_setup_missing" },
          texts: { ready: false, reason: "no_consent" },
        },
      }),
      { mode: 0o600 },
    );
    const lines: string[] = [];
    await computerCli(["doctor"], {
      env: { CLAWDTIME_CONFIG_HOME: root },
      home: root,
      print: (text) => lines.push(text),
    });
    const text = lines.join("\n");
    expect(text).toMatch(
      /calls to you +not ready: the line is not set up for proactive calls/,
    );
    expect(text).toMatch(
      /texts to you +not ready: you did not allow ClawdTime to call and text your number\. To allow it: clawdtime connect --consent yes/,
    );
  });
});
