import { readFile } from "node:fs/promises";
import { probePinnedCuaDaemon } from "../connectors/agents/cua-driver-probe.js";

// This diagnostic reads a protected lead-prepared JSON configuration. It never
// launches a daemon, captures windows, reads conversations or posts app input.
const path = process.argv[2];
if (process.argv.length !== 3 || !path?.startsWith("/")) {
  console.error("Usage: cua-driver-probe /absolute/private/probe-config.json");
  process.exitCode = 2;
} else {
  try {
    const result = await probePinnedCuaDaemon(
      JSON.parse(await readFile(path, "utf8")),
      AbortSignal.timeout(15000),
    );
    console.log(JSON.stringify(result));
  } catch {
    // Native/tool errors can contain window titles, filesystem paths or data.
    console.error(
      "Cua daemon probe blocked. Check the exact daemon identity, private socket, pinned SDK, bounded policy and permission owner.",
    );
    process.exitCode = 1;
  }
}
