import { readFileSync, writeFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  inspectSession,
  inspectionFixture,
} from "../connectors/shared/inspection.js";

/** Explicit file input only; never reads installed configuration or live services. */
export function inspectMain(args = process.argv.slice(2)) {
  let input: string | undefined, output: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index],
      value = args[index + 1];
    if (!value || !["--input", "--export"].includes(flag ?? ""))
      throw new Error(
        "Use --input FIXTURE_JSON and/or --export NEW_REPORT_JSON; no live access is supported.",
      );
    if (flag === "--input") {
      if (input) throw new Error("Duplicate input.");
      input = value;
    }
    if (flag === "--export") {
      if (output) throw new Error("Duplicate export.");
      output = value;
    }
  }
  if (input && statSync(input).size > 1024 * 1024)
    throw new Error("Diagnostic input exceeds 1 MiB.");
  const report = inspectSession(
    input ? JSON.parse(readFileSync(input, "utf8")) : inspectionFixture(),
    input ? "unclassified" : "synthetic",
  );
  const text = JSON.stringify(report, null, 2) + "\n";
  if (output) writeFileSync(output, text, { flag: "wx", mode: 0o600 });
  return text;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.stdout.write(inspectMain());
  } catch {
    process.stderr.write(
      "Session inspection failed: check explicit input, output and schema bounds. No raw diagnostic content is exported.\n",
    );
    process.exitCode = 1;
  }
}
