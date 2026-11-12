import { expect, it } from "vitest";
import { mediaStatusSchema } from "../src/transport/media-diagnostics.js";

const fixture = () => ({
  id: `ct_${"a".repeat(40)}`,
  alive: true,
  state: "active",
  lifecycleDiagnostics: {
    version: 1,
    speech: {
      version: 1,
      at: "2026-11-12T12:00:00+00:00",
      counts: {
        audio_frames: 120,
        provider_final: 3,
        callback_accepted: 1,
        transcript: "PRIVATE",
      },
      state: {
        phase: "idle",
        fragments: 0,
        hasInterim: false,
        vadPending: false,
        ageMs: 0,
        text: "PRIVATE",
      },
      events: [
        {
          sequence: 1,
          event: "provider_final",
          generation: 1,
          elapsedMs: 40,
          startMs: 0,
          durationMs: 3260,
          lastWordEndMs: 3100,
          speechFinal: true,
          characters: 12,
          transcript: "PRIVATE",
          audio: "PRIVATE",
          exception: "PRIVATE",
        },
      ],
      providerBody: "PRIVATE",
    },
  },
});

it("exposes bounded stage counts and timing while stripping transcript/audio/provider payloads", () => {
  const parsed = mediaStatusSchema.parse(fixture());
  expect(parsed.lifecycleDiagnostics?.speech?.counts).toEqual({
    audio_frames: 120,
    provider_final: 3,
    callback_accepted: 1,
  });
  expect(parsed.lifecycleDiagnostics?.speech?.events[0]).toMatchObject({
    event: "provider_final",
    durationMs: 3260,
  });
  expect(JSON.stringify(parsed)).not.toContain("PRIVATE");
});

it("rejects arbitrary event categories, excessive history and unbounded telemetry", () => {
  for (const change of [
    (value: ReturnType<typeof fixture>) => {
      value.lifecycleDiagnostics.speech.events[0]!.event = "PRIVATE";
    },
    (value: ReturnType<typeof fixture>) => {
      value.lifecycleDiagnostics.speech.events = Array(65).fill(
        value.lifecycleDiagnostics.speech.events[0],
      );
    },
    (value: ReturnType<typeof fixture>) => {
      value.lifecycleDiagnostics.speech.counts.audio_frames = Infinity;
    },
  ]) {
    const value = fixture();
    change(value);
    expect(mediaStatusSchema.safeParse(value).success).toBe(false);
  }
  expect(
    mediaStatusSchema.safeParse({
      id: `ct_${"a".repeat(40)}`,
      alive: false,
      state: "closed",
      lifecycleDiagnostics: { version: 1 },
    }).success,
  ).toBe(true);
});
