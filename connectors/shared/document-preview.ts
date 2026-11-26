import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocumentCandidate } from "../../src/contracts.js";
import { executorEnvironment } from "../codex/app-server.js";

const extensions: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    ".docx",
  "application/vnd.apple.pages": ".pages",
};

/** First-page thumbnail only. Fixed QuickLook invocation uses the OS renderer sandbox; no extra network sandbox is claimed. */
export async function withDocumentPreview<T>(
  candidate: DocumentCandidate,
  source: Buffer,
  signal: AbortSignal,
  guard: () => Promise<void>,
  consume: (png: Buffer) => Promise<T>,
): Promise<T> {
  if (
    process.platform !== "darwin" ||
    !extensions[candidate.mimeType] ||
    signal.aborted
  )
    throw new Error("Bounded document preview is unavailable.");
  await guard();
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "clawdtime-document-preview-")),
  );
  let png: Buffer | undefined;
  try {
    const input = join(root, "document" + extensions[candidate.mimeType]);
    await writeFile(input, source, { mode: 0o600, flag: "wx" });
    await guard();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "/usr/bin/qlmanage",
        ["-t", "-s", "1280", "-o", root, input],
        {
          cwd: root,
          env: executorEnvironment(),
          stdio: ["ignore", "ignore", "ignore"],
        },
      );
      let stopped = false;
      const stop = () => {
        stopped = true;
        child.kill("SIGKILL");
      };
      const timeout = setTimeout(stop, 15_000);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      child.once("error", () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", stop);
        reject(new Error("Document renderer unavailable."));
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", stop);
        code === 0 && !stopped
          ? resolve()
          : reject(new Error("Document preview was stopped or unavailable."));
      });
    });
    await guard();
    if (signal.aborted) throw new Error("Document preview stopped.");
    const outputs = (await readdir(root)).filter((name) =>
      name.endsWith(".png"),
    );
    if (outputs.length !== 1)
      throw new Error("Document preview image missing or ambiguous.");
    const image = await open(
      join(root, outputs[0]!),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await image.stat();
      if (!stat.isFile() || stat.size < 33 || stat.size > 2 * 1024 * 1024)
        throw new Error("Document preview exceeds image bound.");
      png = await image.readFile();
    } finally {
      await image.close();
    }
    if (
      !png
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      png.subarray(12, 16).toString("ascii") !== "IHDR" ||
      png.readUInt32BE(16) < 1 ||
      png.readUInt32BE(20) < 1 ||
      png.readUInt32BE(16) > 1280 ||
      png.readUInt32BE(20) > 1280
    )
      throw new Error("Document preview is not the expected bounded PNG.");
    await guard();
    if (signal.aborted) throw new Error("Document preview stopped.");
    return await consume(png);
  } finally {
    png?.fill(0);
    await rm(root, { recursive: true, force: true });
  }
}
