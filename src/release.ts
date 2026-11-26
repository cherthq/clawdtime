import { readFileSync } from "node:fs";

/** Baked into the frozen release archive, never inferred from mutable runtime env. */
export function releaseSourceRevision(): string {
  try {
    const value = JSON.parse(
      readFileSync(new URL("../release-source.json", import.meta.url), "utf8"),
    ).sourceRevision;
    return typeof value === "string" &&
      /^(development|[a-f0-9]{40})$/.test(value)
      ? value
      : "unavailable";
  } catch {
    return "unavailable";
  }
}
