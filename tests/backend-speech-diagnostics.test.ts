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

it("exposes commentary receipt counters without content or correlation identifiers", () => {
  const voiceCommentary = {
    version: 1,
    queued: 999999999,
    acknowledged: 2,
    rejected: 1,
    unknown: 0,
    pending: 64,
    lastAckMs: 60000,
  };
  const parsed = mediaStatusSchema.parse({
    ...fixture(),
    lifecycleDiagnostics: {
      version: 1,
      voiceCommentary: {
        ...voiceCommentary,
        text: "PRIVATE",
        commentaryId: "PRIVATE",
        jobId: "PRIVATE",
        receipts: [{ content: "PRIVATE" }],
      },
    },
  });
  expect(parsed.lifecycleDiagnostics?.voiceCommentary).toEqual(voiceCommentary);
  expect(JSON.stringify(parsed)).not.toContain("PRIVATE");
  const beforeAck = mediaStatusSchema.parse({
    ...fixture(),
    lifecycleDiagnostics: {
      version: 1,
      voiceCommentary: { ...voiceCommentary, lastAckMs: null },
    },
  });
  expect(beforeAck.lifecycleDiagnostics?.voiceCommentary?.lastAckMs).toBeNull();
});

it("rejects malformed or unbounded commentary counters and timing", () => {
  const valid = {
    version: 1,
    queued: 0,
    acknowledged: 0,
    rejected: 0,
    unknown: 0,
    pending: 0,
    lastAckMs: null,
  };
  for (const invalid of [
    { version: 2 },
    { queued: 1000000000 },
    { acknowledged: -1 },
    { rejected: 0.5 },
    { unknown: Infinity },
    { pending: 65 },
    { pending: -1 },
    { lastAckMs: 60001 },
    { lastAckMs: NaN },
    { lastAckMs: -1 },
    { lastAckMs: 1.5 },
    { lastAckMs: "1" },
  ]) {
    expect(
      mediaStatusSchema.safeParse({
        ...fixture(),
        lifecycleDiagnostics: {
          version: 1,
          voiceCommentary: { ...valid, ...invalid },
        },
      }).success,
    ).toBe(false);
  }
});
