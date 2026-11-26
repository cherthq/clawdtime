/** Real local QuickLook qualification using only newly generated synthetic documents. No upload. */
import { createHash } from "node:crypto";
import { withDocumentPreview } from "../connectors/shared/document-preview.js";
import { fixturePdf, fixtureDocx } from "./connectors-document-fixtures.js";
const results: object[] = [];
for (const [name, bytes, mimeType] of [
  ["fixture.pdf", fixturePdf(), "application/pdf"],
  [
    "fixture.docx",
    fixtureDocx(),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
] as const) {
  const began = performance.now();
  try {
    await withDocumentPreview(
      {
        id: "doc_" + "a".repeat(64),
        grantId: "synthetic",
        name,
        mimeType,
        byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        previewSupport: "first_page",
      },
      bytes,
      new AbortController().signal,
      async () => {},
      async (png) => {
        results.push({
          format: mimeType,
          verifiedPng: true,
          firstPageOnly: true,
          bytes: png.length,
          width: png.readUInt32BE(16),
          height: png.readUInt32BE(20),
          elapsedMs: Math.round(performance.now() - began),
        });
      },
    );
  } catch {
    results.push({
      format: mimeType,
      verifiedPng: false,
      elapsedMs: Math.round(performance.now() - began),
    });
    process.exitCode = 1;
  } finally {
    bytes.fill(0);
  }
}
console.log(
  JSON.stringify({
    syntheticDocuments: true,
    actualQuickLook: true,
    uploaded: false,
    results,
  }),
);
