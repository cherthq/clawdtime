/** Summarize consented metadata-only trials; never drives UI or invents missing trials. */
import { readFileSync } from "node:fs";
import { z } from "zod";
const trial = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
    adapter: z.enum(["native", "custom"]),
    operation: z.enum(["click", "type", "scroll", "grounded"]),
    activeCall: z.boolean(),
    fixture: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    toolVersion: z.string().min(1).max(100),
    modelVersion: z.string().min(1).max(100),
    outcome: z.enum([
      "verified",
      "failed",
      "canceled",
      "unknown",
      "timeout",
      "unavailable",
    ]),
    elapsedMs: z.number().nonnegative().max(3_600_000).nullable(),
    frameAgeMs: z.number().nonnegative().max(60_000).nullable(),
    corrected: z.boolean(),
    costUsd: z.number().nonnegative().nullable(),
    handsetAudibleMs: z.number().nonnegative().nullable(),
    interruptionCutoffMs: z.number().nonnegative().nullable(),
  })
  .strict();
const file = process.argv[2];
if (!file)
  throw new Error("Usage: npx tsx scripts/benchmark-control.ts METADATA.jsonl");
const raw = readFileSync(file, "utf8");
if (Buffer.byteLength(raw) > 4 * 1024 * 1024)
  throw new Error("Trial file exceeds bound.");
const rows = raw
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => trial.parse(JSON.parse(line)));
if (new Set(rows.map((r) => r.id)).size !== rows.length)
  throw new Error("Duplicate trial identity.");
const stats = (values: (number | null)[]) => {
  const sorted = values
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
  return {
    measured: sorted.length,
    missing: values.length - sorted.length,
    medianMs: sorted.length
      ? sorted[Math.floor((sorted.length - 1) / 2)]
      : null,
    p95Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
  };
};
const groups = [];
for (const adapter of ["native", "custom"] as const)
  for (const operation of ["click", "type", "scroll", "grounded"] as const)
    for (const activeCall of [false, true]) {
      const selected = rows.filter(
        (r) =>
          r.adapter === adapter &&
          r.operation === operation &&
          r.activeCall === activeCall,
      );
      const verified = selected.filter((r) => r.outcome === "verified");
      groups.push({
        adapter,
        operation,
        activeCall,
        trials: selected.length,
        minimumMet: selected.length >= 30,
        verified: verified.length,
        verifiedRate: selected.length
          ? verified.length / selected.length
          : null,
        outcomes: Object.fromEntries(
          [
            "verified",
            "failed",
            "canceled",
            "unknown",
            "timeout",
            "unavailable",
          ].map((o) => [o, selected.filter((r) => r.outcome === o).length]),
        ),
        allLatency: stats(selected.map((r) => r.elapsedMs)),
        verifiedLatency: stats(verified.map((r) => r.elapsedMs)),
        frameAge: stats(selected.map((r) => r.frameAgeMs)),
        handsetAudibility: stats(selected.map((r) => r.handsetAudibleMs)),
        interruptionCutoff: stats(selected.map((r) => r.interruptionCutoffMs)),
        corrections: selected.filter((r) => r.corrected).length,
        fixtures: [...new Set(selected.map((r) => r.fixture))],
        toolVersions: [...new Set(selected.map((r) => r.toolVersion))],
        modelVersions: [...new Set(selected.map((r) => r.modelVersion))],
        costUsd: selected.every((r) => r.costUsd !== null)
          ? selected.reduce((n, r) => n + r.costUsd!, 0)
          : null,
      });
    }
console.log(
  JSON.stringify(
    {
      version: 1,
      kind: "recorded_trials_only",
      autoSelectionQualified: false,
      groups,
    },
    null,
    2,
  ),
);
