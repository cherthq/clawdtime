import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  realpath,
  writeFile,
  readFile,
  rm,
  symlink,
  unlink,
  rename,
  mkdir,
  truncate,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { LocalDocuments } from "../connectors/shared/local-documents.js";
import {
  DocumentRunner,
  type DocumentAssetPort,
} from "../connectors/shared/document-runner.js";
import type {
  DocumentRootGrant,
  RunnerRequest,
  DocumentOperation,
} from "../src/contracts.js";
import {
  fixturePdf,
  fixtureDocx,
  fixtureZip,
} from "./connectors-document-fixtures.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "clawdtime-documents-test-")),
  );
  roots.push(root);
  const grant: DocumentRootGrant = {
    id: "grant",
    sessionId: "session",
    pairingId: "pair",
    memberId: "member",
    hostId: "host",
    projectRoot: root,
    state: "active",
    expiresAt: Date.now() + 60_000,
  };
  await writeFile(join(root, "fixture.pdf"), fixturePdf());
  return { root, grant, signal: new AbortController().signal };
}
it("discovers only bounded supported regular documents, including extensionless DOCX", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "no-extension"), fixtureDocx());
  await writeFile(
    join(f.root, "fixture.pages"),
    fixtureZip({
      "Index/Document.iwa": "synthetic",
      "Metadata/Properties.plist": "synthetic",
    }),
  );
  await writeFile(join(f.root, "fake.docx"), "not a document");
  await symlink(join(f.root, "fixture.pdf"), join(f.root, "alias.pdf"));
  await mkdir(join(f.root, "package.pages"));
  const values = await new LocalDocuments(f.grant, () => {}).discover(f.signal);
  expect(values.map((item) => item.name)).toEqual([
    "fixture.pages",
    "fixture.pdf",
    "no-extension",
  ]);
  expect(
    values.every(
      (item) => /^doc_[a-f0-9]{64}$/.test(item.id) && item.sha256.length === 64,
    ),
  ).toBe(true);
  expect(values.at(-1)!.mimeType).toBe(
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
});
it("verifies exact selection and erases the transient buffer after consumption", async () => {
  const f = await fixture(),
    documents = new LocalDocuments(f.grant, () => {}),
    candidate = (await documents.discover(f.signal))[0]!;
  let held: Buffer | undefined;
  await documents.withVerifiedDocument(
    { candidateId: candidate.id, sha256: candidate.sha256 },
    f.signal,
    async (actual, bytes, guard) => {
      await guard();
      held = bytes;
      expect(actual).toEqual(candidate);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        candidate.sha256,
      );
    },
  );
  expect(held!.every((byte) => byte === 0)).toBe(true);
  expect(await readFile(join(f.root, "fixture.pdf"))).toEqual(fixturePdf());
});
it.each(["changed", "symlink"])(
  "rejects %s selected files before returning bytes",
  async (change) => {
    const f = await fixture(),
      documents = new LocalDocuments(f.grant, () => {}),
      candidate = (await documents.discover(f.signal))[0]!;
    if (change === "changed")
      await writeFile(
        join(f.root, "fixture.pdf"),
        Buffer.concat([fixturePdf(), Buffer.from("changed")]),
      );
    else {
      await unlink(join(f.root, "fixture.pdf"));
      await symlink("/etc/hosts", join(f.root, "fixture.pdf"));
    }
    let consumed = false;
    await expect(
      documents.withVerifiedDocument(
        { candidateId: candidate.id, sha256: candidate.sha256 },
        f.signal,
        async () => {
          consumed = true;
        },
      ),
    ).rejects.toThrow();
    expect(consumed).toBe(false);
  },
);
it("rejects inode replacement during the verified read", async () => {
  const f = await fixture();
  let checks = 0,
    replace = false;
  const documents = new LocalDocuments(f.grant, async () => {
    if (replace && ++checks === 3) {
      await writeFile(join(f.root, "replacement"), fixturePdf());
      await rename(join(f.root, "replacement"), join(f.root, "fixture.pdf"));
    }
  });
  const candidate = (await documents.discover(f.signal))[0]!;
  replace = true;
  await expect(
    documents.withVerifiedDocument(
      { candidateId: candidate.id, sha256: candidate.sha256 },
      f.signal,
      async () => {},
    ),
  ).rejects.toThrow("changed during read");
});
it("honors local Stop and expiry without reading or consuming selected bytes", async () => {
  const f = await fixture(),
    controller = new AbortController();
  controller.abort();
  await expect(
    new LocalDocuments(f.grant, () => {}).discover(controller.signal),
  ).rejects.toThrow("stopped");
  await expect(
    new LocalDocuments({ ...f.grant, expiresAt: 1 }, () => {}).discover(
      f.signal,
    ),
  ).rejects.toThrow("expired");
  await expect(
    new LocalDocuments(f.grant, () => {
      throw new Error("Backend revoked grant");
    }).discover(f.signal),
  ).rejects.toThrow("revoked");
});
it("refuses a symlink root and an oversized regular file", async () => {
  const f = await fixture();
  await symlink(f.root, join(f.root, "alias"));
  await expect(
    new LocalDocuments(
      { ...f.grant, projectRoot: join(f.root, "alias") },
      () => {},
    ).discover(f.signal),
  ).rejects.toThrow("exact authorized");
  await truncate(join(f.root, "fixture.pdf"), 10 * 1024 * 1024 + 1);
  await expect(
    new LocalDocuments(f.grant, () => {}).discover(f.signal),
  ).rejects.toThrow("bounded");
});
function job(
  grant: DocumentRootGrant,
  operation: DocumentOperation,
  revision = 1,
): RunnerRequest {
  return {
    projectRoot: grant.projectRoot,
    externalSessionId: "external",
    intent: {
      instruction: "Deterministic document operation",
      kind: "document",
      preference: "auto",
      document: operation,
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
it("uses real digest verification for deterministic discovery and exact transfer receipts", async () => {
  const f = await fixture();
  let uploads = 0;
  const port: DocumentAssetPort = {
    async upload(_dispatch, purpose, candidate, bytes, transferId) {
      uploads++;
      expect(purpose).toBe("transfer");
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        candidate.sha256,
      );
      return { transferId, verificationEvidenceId: "provider-receipt-fixture" };
    },
  };
  const runner = new DocumentRunner(f.grant, port, () => {});
  const found = await runner.run(
    job(f.grant, { operation: "discover", grantId: f.grant.id }),
    () => {},
    f.signal,
  );
  expect(found.verification?.method).toBe("document_digest");
  const candidate = found.document!.candidates![0]!;
  const request = job(
    f.grant,
    {
      operation: "prepare_transfer",
      grantId: f.grant.id,
      candidate,
      transferId: "transfer",
    },
    2,
  );
  const result = await runner.run(request, () => {}, f.signal);
  expect(result).toMatchObject({
    outcome: "succeeded",
    document: { transferId: "transfer" },
    verification: { method: "attachment_receipt", verified: true },
  });
  expect((await runner.run(request, () => {}, f.signal)).outcome).toBe(
    "unknown",
  );
  expect(uploads).toBe(1);
});
it("keeps ambiguous uploads unknown and does not retry or switch adapters", async () => {
  const f = await fixture();
  let uploads = 0;
  const runner = new DocumentRunner(
    f.grant,
    {
      async upload() {
        uploads++;
        throw new Error("Lost acknowledgement");
      },
    },
    () => {},
  );
  const found = await runner.run(
    job(f.grant, { operation: "discover", grantId: f.grant.id }),
    () => {},
    f.signal,
  );
  const request = job(
    f.grant,
    {
      operation: "prepare_transfer",
      grantId: f.grant.id,
      candidate: found.document!.candidates![0]!,
      transferId: "transfer",
    },
    2,
  );
  expect(await runner.run(request, () => {}, f.signal)).toMatchObject({
    outcome: "unknown",
    unresolvedEffectIds: ["job:2"],
  });
  expect(uploads).toBe(1);
});
it("rejects forged candidate metadata and foreign sessions before uploading", async () => {
  const f = await fixture();
  let uploads = 0;
  const runner = new DocumentRunner(
    f.grant,
    {
      async upload() {
        uploads++;
        return { verificationEvidenceId: "fixture" };
      },
    },
    () => {},
  );
  const found = await runner.run(
    job(f.grant, { operation: "discover", grantId: f.grant.id }),
    () => {},
    f.signal,
  );
  const candidate = {
    ...found.document!.candidates![0]!,
    name: "different.pdf",
  };
  expect(
    (
      await runner.run(
        job(
          f.grant,
          {
            operation: "prepare_transfer",
            grantId: f.grant.id,
            candidate,
            transferId: "transfer",
          },
          2,
        ),
        () => {},
        f.signal,
      )
    ).outcome,
  ).toBe("failed");
  const forged = job(
    f.grant,
    { operation: "discover", grantId: f.grant.id },
    3,
  );
  forged.job.sessionId = "other";
  expect((await runner.run(forged, () => {}, f.signal)).outcome).toBe("failed");
  expect(uploads).toBe(0);
});
