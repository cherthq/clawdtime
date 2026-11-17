import { expect, it } from "vitest";
import { mediaStatusSchema } from "../src/transport/media-diagnostics.js";

const at = "2026-11-17T14:00:00+00:00";
const result = { stage: "monitor_authority", at, durationMs: 90 };
const fixture = (fields: Record<string, unknown> = {}) => ({
  id: `ct_${"a".repeat(40)}`,
  alive: true,
  state: "active",
  screenDiagnostics: {
    version: 1,
    phase: "viewing",
    updatedAt: at,
    framesReceived: 1,
    videoFramesEmitted: 1,
    ...fields,
  },
});

it("retains bounded presentation stage timing and strips private payloads at each level", () => {
  const parsed = mediaStatusSchema.parse(
    fixture({
      privateTitle: "PRIVATE",
      lastPresentationResult: {
        ...result,
        label: "PRIVATE",
        window: { title: "PRIVATE" },
        authority: { token: "PRIVATE" },
        pixels: "PRIVATE",
      },
      lastPresentationFailure: {
        ...result,
        error: "timeout",
        exception: "PRIVATE",
        url: "PRIVATE",
        requestId: "PRIVATE",
      },
    }),
  );
  expect(parsed.screenDiagnostics?.lastPresentationResult).toEqual(result);
  expect(parsed.screenDiagnostics?.lastPresentationFailure).toEqual({
    ...result,
    error: "timeout",
  });
  expect(JSON.stringify(parsed)).not.toContain("PRIVATE");
});

it("accepts every fixed stage and bounded error category without requiring new fields from old peers", () => {
  expect(mediaStatusSchema.safeParse(fixture()).success).toBe(true);
  for (const stage of [
    "initial_authority",
    "first_resolve",
    "second_resolve",
    "final_authority",
    "monitor_resolve",
    "monitor_authority",
    "monitor_cycle",
  ])
    for (const error of [undefined, "timeout", "cancelled", "refused"])
      expect(
        mediaStatusSchema.safeParse(
          fixture({
            lastPresentationResult: { ...result, stage, error, durationMs: 0 },
            lastPresentationFailure: {
              ...result,
              stage,
              error,
              durationMs: 999999,
            },
          }),
        ).success,
      ).toBe(true);
});

it("rejects raw errors, unknown stages, invalid timestamps and unbounded timing in both fields", () => {
  for (const key of ["lastPresentationResult", "lastPresentationFailure"])
    for (const invalid of [
      { stage: "PRIVATE window title" },
      { error: "PRIVATE upstream exception" },
      { error: null },
      { at: "PRIVATE" },
      { at: "2026-11-17T14:00:00" },
      { durationMs: -1 },
      { durationMs: 1000000 },
      { durationMs: 0.5 },
      { durationMs: Infinity },
      { durationMs: NaN },
      { durationMs: "90" },
      { durationMs: true },
    ])
      expect(
        mediaStatusSchema.safeParse(
          fixture({ [key]: { ...result, ...invalid } }),
        ).success,
      ).toBe(false);
});
