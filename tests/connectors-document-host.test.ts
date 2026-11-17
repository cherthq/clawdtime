import { afterEach, expect, it } from "vitest";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDocumentHost } from "../connectors/shared/document-host.js";
import { protocolOptions } from "../connectors/shared/protocol.js";
import type {
  AgentSession,
  DocumentRootGrant,
  RunnerRequest,
  DocumentOperation,
} from "../src/contracts.js";
import { fixturePdf } from "./connectors-document-fixtures.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "clawdtime-document-host-")),
  );
  roots.push(root);
  await writeFile(join(root, "Résumé_日本.pdf"), fixturePdf());
  const expiresAt = Date.now() + 60_000;
  const session: AgentSession = {
    id: "session",
    pairingId: "pair",
    projectRoot: root,
    hostId: "host",
    adapter: "codex",
    adapterVersion: "fixture",
    externalSessionId: "external",
    state: "active",
    controlEpoch: 0,
    createdAt: Date.now(),
    protocolVersion: 2,
    capabilities: {
      cooperativePause: true,
      polling: true,
      nativeControl: "none",
    },
    conversation: {
      version: 1,
      runnerId: "remote-documents",
      executionSession: "api_managed",
    },
    documentAccess: { version: 1, readOnly: true, expiresAt },
  };
  const grant: DocumentRootGrant = {
    id: "grant",
    sessionId: session.id,
    pairingId: session.pairingId,
    memberId: "member",
    hostId: session.hostId,
    projectRoot: root,
    expiresAt,
    state: "active",
  };
  return { root, session, grant };
}
function request(
  grant: DocumentRootGrant,
  document: DocumentOperation,
  revision = 1,
): RunnerRequest {
  return {
    projectRoot: grant.projectRoot,
    externalSessionId: "external",
    intent: {
      instruction: "Document operation",
      kind: "document",
      preference: "auto",
      document,
    },
    job: {
      id: "job",
      dispatchId: `job:${revision}`,
      version: 1,
      sessionId: grant.sessionId,
      pairingId: grant.pairingId,
      memberId: grant.memberId,
      runnerId: "remote-documents",
      revision,
      instructionSequence: revision,
      kind: "document",
      preference: "auto",
      state: "running",
      source: { channel: "text", eventId: String(revision) },
      createdAt: 1,
      updatedAt: 1,
    },
  };
}
it("uses exact fresh grant, transient binary bytes, and ASCII-safe exact candidate metadata", async () => {
  const f = await fixture();
  const paths: string[] = [];
  let uploaded = false;
  const fetcher = (async (url, init) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    expect(
      new Headers(init?.headers).get("authorization") ===
        "Bearer synthetic-session-token",
    ).toBe(true);
    if (path.endsWith("/grant")) return Response.json({ grant: f.grant });
    if (path.endsWith("/stop")) return Response.json({ stopped: true });
    const header = new Headers(init?.headers).get("X-ClawdTime-Document")!;
    expect(/^[\x20-\x7e]*$/.test(header)).toBe(true);
    const metadata = JSON.parse(
      Buffer.from(header, "base64url").toString("utf8"),
    );
    expect(metadata.candidate.name).toBe("Résumé_日本.pdf");
    expect(metadata.purpose).toBe("transfer");
    expect(Buffer.from(init!.body as Uint8Array)).toEqual(fixturePdf());
    uploaded = true;
    return Response.json({
      transferId: "transfer",
      verificationEvidenceId: "exact-provider-fixture",
    });
  }) as typeof fetch;
  const host = await createDocumentHost(
      f.session,
      "https://fixture.invalid",
      "synthetic-session-token",
      fetcher,
    ),
    signal = new AbortController().signal;
  expect(host.runner.capabilities()).toMatchObject({
    host: "local_documents",
    nativeControl: "none",
    taskKinds: ["document"],
  });
  const discovery = await host.runner.run(
    request(f.grant, { operation: "discover", grantId: f.grant.id }),
    () => {},
    signal,
  );
  const transferred = await host.runner.run(
    request(
      f.grant,
      {
        operation: "prepare_transfer",
        grantId: f.grant.id,
        candidate: discovery.document!.candidates![0]!,
        transferId: "transfer",
      },
      2,
    ),
    () => {},
    signal,
  );
  expect(transferred.outcome).toBe("succeeded");
  expect(uploaded).toBe(true);
  expect(
    paths.filter((path) => path.endsWith("/grant")).length,
  ).toBeGreaterThan(2);
  await Promise.all([host.stop(), host.stop()]);
  expect(paths.filter((path) => path.endsWith("/stop"))).toHaveLength(1);
  expect(paths.filter((path) => path.endsWith("/assets"))).toHaveLength(1);
});
it("refuses a grant rebound to a different root or host before any document operation", async () => {
  const f = await fixture();
  for (const changed of [
    { ...f.grant, projectRoot: "/different" },
    { ...f.grant, hostId: "different" },
    { ...f.grant, expiresAt: f.grant.expiresAt + 1 },
  ])
    await expect(
      createDocumentHost(
        f.session,
        "https://fixture.invalid",
        "synthetic",
        (async () => Response.json({ grant: changed })) as typeof fetch,
      ),
    ).rejects.toThrow("changed");
});
it("rechecks revocation before reading and does not submit any upload", async () => {
  const f = await fixture();
  let count = 0;
  const host = await createDocumentHost(
    f.session,
    "https://fixture.invalid",
    "synthetic",
    (async () =>
      Response.json({
        grant: ++count === 1 ? f.grant : { ...f.grant, state: "revoked" },
      })) as typeof fetch,
  );
  const result = await host.runner.run(
    request(f.grant, { operation: "discover", grantId: f.grant.id }),
    () => {},
    new AbortController().signal,
  );
  expect(result.outcome).toBe("failed");
  expect(count).toBe(2);
});
it("requires explicit bounded immutable read-only document registration", () => {
  const until = new Date(Date.now() + 900_000).toISOString();
  const flags = {
    runner: "remote-documents",
    "execution-session": "api_managed",
    "document-access-until": until,
  };
  expect(protocolOptions(flags).documentAccess).toEqual({
    version: 1,
    readOnly: true,
    expiresAt: Date.parse(until),
  });
  expect(() =>
    protocolOptions({
      runner: "remote-documents",
      "execution-session": "api_managed",
    }),
  ).toThrow("document-access-until");
  expect(() =>
    protocolOptions({ ...flags, runner: "remote-codex-app-server" }),
  ).toThrow();
  expect(() =>
    protocolOptions({
      ...flags,
      "document-access-until": new Date(Date.now() + 7_200_000).toISOString(),
    }),
  ).toThrow("within one hour");
  expect(() =>
    protocolOptions({ ...flags, "native-control": "desktop" }),
  ).toThrow("native tools");
});
it("does not claim remote Stop was acknowledged by an unrelated successful response", async () => {
  const f = await fixture();
  let stops = 0;
  const host = await createDocumentHost(
    f.session,
    "https://fixture.invalid",
    "synthetic",
    (async (url) => {
      if (String(url).endsWith("/stop")) {
        stops++;
        return Response.json({ ok: true });
      }
      return Response.json({ grant: f.grant });
    }) as typeof fetch,
  );
  expect(await host.stop()).toBe(false);
  expect(await host.stop()).toBe(false);
  expect(stops).toBe(1);
  const result = await host.runner.run(
    request(f.grant, { operation: "discover", grantId: f.grant.id }),
    () => {},
    new AbortController().signal,
  );
  expect(result.outcome).toBe("failed");
});
