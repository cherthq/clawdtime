import { z } from "zod";
import { connectorOperations } from "./timing.js";
import {
  explainReadiness,
  readinessReasons,
  type ReadinessCheck,
  type ReadinessReason,
} from "./readiness.js";

const stageNames = [
  "capture_open",
  "provider_final",
  "utterance_emitted",
  "callback_accepted",
  "callback_failed",
  "callback_refused",
  "agent_acknowledged",
  "execution_reported",
  "approval_reported",
  "reply_accepted",
  "playback_started",
  "playback_completed",
  "playback_failed",
  "playback_unknown",
  "outcome_reported",
  "end_requested",
  "cleanup_confirmed",
  "message_queued",
  "message_acknowledged",
  "ownership_started",
  "ownership_completed",
  "ownership_failed",
  "frame_started",
  "frame_completed",
  "frame_failed",
  "input_started",
  "input_submitted",
  "input_observed",
  "input_failed",
  "speech_onset",
  "interruption_detected",
  "playback_cleared",
  "interruption_reported",
  "interruption_unconfirmed",
  "tts_requested",
  "tts_first_byte",
  "audio_first_published",
  "audio_last_published",
  "event_loop_lag",
  ...connectorOperations.flatMap((operation) =>
    ["started", "completed", "failed"].map(
      (state) => `connector_${operation}_${state}`,
    ),
  ),
] as const;
const stages = new Set<string>(stageNames);
const hex = (size: number) =>
  z.string().regex(new RegExp(`^[a-f0-9]{${size}}$`));
const eventSchema = z.object({
  sequence: z.number().int().nonnegative().max(999999999),
  event: z.enum(stageNames),
  correlationId: hex(24),
  generation: z.number().int().nonnegative().max(999999999).default(0),
  playbackGeneration: z.number().int().nonnegative().max(999999999).optional(),
  elapsedMs: z.number().int().min(0).max(86400000),
  at: z.string().datetime({ offset: true }).optional(),
});
type Event = z.infer<typeof eventSchema> & { processId: string };
const pairs = [
  ["capture_to_final", "capture_open", "utterance_emitted"],
  ["final_to_backend", "utterance_emitted", "callback_accepted"],
  ["backend_to_agent", "callback_accepted", "agent_acknowledged"],
  ["agent_to_execution", "agent_acknowledged", "execution_reported"],
  ["reply_to_playback", "reply_accepted", "playback_started"],
  ["playback", "playback_started", "playback_completed"],
  ["execution_to_outcome", "execution_reported", "outcome_reported"],
  ["end_to_cleanup", "end_requested", "cleanup_confirmed"],
  ["message_to_transport", "message_queued", "message_acknowledged"],
  ["ownership", "ownership_started", "ownership_completed"],
  ["frame", "frame_started", "frame_completed"],
  ["input_submission", "input_started", "input_submitted"],
  ["input_observation", "input_submitted", "input_observed"],
  ["tts_first_byte", "tts_requested", "tts_first_byte"],
  ["tts_first_publication", "tts_requested", "audio_first_published"],
  ["interruption_clear", "interruption_detected", "playback_cleared"],
  ["interruption_report", "interruption_detected", "interruption_reported"],
  ...connectorOperations.map(
    (operation) =>
      [
        `connector_${operation}_round_trip`,
        `connector_${operation}_started`,
        `connector_${operation}_completed`,
      ] as const,
  ),
] as const;
const record = (raw: unknown): Record<string, unknown> =>
  raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};

export function quantiles(samples: number[]) {
  const values = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return {
    medianMs: values.length
      ? values.length % 2
        ? values[middle]!
        : (values[middle - 1]! + values[middle]!) / 2
      : null,
    p95Ms: values.length ? values[Math.ceil(values.length * 0.95) - 1]! : null,
  };
}

/** A strict export projection, never a dump of the input diagnostic response. */
export function inspectSession(
  raw: unknown,
  measurementKind: "synthetic" | "physical" | "unclassified" = "unclassified",
) {
  const input = record(raw),
    media = record(input.media);
  const lifecycle = record(media.lifecycleDiagnostics);
  const sources = [
    input.conversationTimeline,
    media.speechPipeline,
    lifecycle.speech,
    input.connectorTiming,
    input.controlTiming,
  ].filter(Boolean);
  const events: Event[] = [];
  const loopLag: number[] = [];
  let invalidCount = 0,
    uncorrelatedCount = 0,
    overflowCount = 0;
  for (const source of sources.slice(0, 5)) {
    const value = record(source),
      process = hex(32).safeParse(value.processId);
    const rawEvents = Array.isArray(value.events) ? value.events : [];
    overflowCount += Math.max(0, rawEvents.length - 64);
    for (const item of rawEvents.slice(-64)) {
      const candidate = record(item);
      if (!stages.has(String(candidate.event))) continue;
      if (candidate.event === "event_loop_lag") {
        const duration = z
          .number()
          .finite()
          .min(0)
          .max(86400000)
          .safeParse(candidate.durationMs);
        const elapsed = z
          .number()
          .int()
          .min(0)
          .max(86400000)
          .safeParse(candidate.elapsedMs);
        if (process.success && duration.success && elapsed.success)
          loopLag.push(duration.data);
        else invalidCount++;
        continue;
      }
      if (!process.success || candidate.correlationId === undefined) {
        uncorrelatedCount++;
        continue;
      }
      const parsed = eventSchema.safeParse(candidate);
      if (!parsed.success) {
        invalidCount++;
        continue;
      }
      events.push({ ...parsed.data, processId: process.data });
    }
  }
  const metrics = pairs.map(([name, start, end]) => {
    const playbackScoped =
      name === "tts_first_byte" || name === "tts_first_publication";
    const groups = new Map<string, Event[]>();
    for (const [index, event] of events.entries()) {
      // Half-duplex playback intentionally restarts capture. Only an explicit
      // playback generation can join TTS stages across those capture changes.
      // Missing playback identity stays unmatched; never infer it from neighbors.
      const scope = playbackScoped
        ? event.playbackGeneration === undefined
          ? `unidentified:${index}`
          : `playback:${event.playbackGeneration}`
        : `capture:${event.generation}`;
      const key = `${event.processId}:${scope}:${event.correlationId}`;
      const group = groups.get(key) ?? [];
      group.push(event);
      groups.set(key, group);
    }
    const samples: number[] = [];
    let missingCount = 0,
      failedCount = 0,
      attemptedCount = 0;
    for (const group of groups.values()) {
      const starts = group.filter((e) => e.event === start),
        ends = group.filter((e) => e.event === end);
      const failureEvents: string[] =
        name === "final_to_backend"
          ? ["callback_failed", "callback_refused"]
          : name === "playback" ||
              name === "tts_first_byte" ||
              name === "tts_first_publication"
            ? ["playback_failed", "playback_unknown"]
            : name === "ownership"
              ? ["ownership_failed"]
              : name === "frame"
                ? ["frame_failed"]
                : name === "input_submission" || name === "input_observation"
                  ? ["input_failed"]
                  : name === "interruption_report"
                    ? ["interruption_unconfirmed"]
                    : name.startsWith("connector_")
                      ? [start.replace(/_started$/, "_failed")]
                      : [];
      const failure = group.some((e) => failureEvents.includes(e.event));
      if (!starts.length && !ends.length && !failure) continue;
      attemptedCount++;
      if (failure) {
        failedCount++;
        continue;
      }
      if (!starts.length || !ends.length) {
        missingCount++;
        continue;
      }
      const a = starts[0]!,
        b = ends[0]!;
      // Duplicates and backwards sequence/time cannot become a successful sample.
      if (
        starts.length !== 1 ||
        ends.length !== 1 ||
        b.sequence <= a.sequence ||
        b.elapsedMs < a.elapsedMs
      ) {
        failedCount++;
        continue;
      }
      samples.push(b.elapsedMs - a.elapsedMs);
    }
    return {
      name,
      durationKind: "process_local_monotonic" as const,
      boundary: name.startsWith("connector_")
        ? ("connector_http_round_trip" as const)
        : ("recorded_stage_interval" as const),
      attemptedCount,
      sampleCount: samples.length,
      failedCount,
      missingCount,
      ...quantiles(samples),
    };
  });
  const processes = new Map<string, string>(),
    correlations = new Map<string, string>();
  const label = (map: Map<string, string>, key: string, prefix: string) => {
    if (!map.has(key)) map.set(key, `${prefix}${map.size + 1}`);
    return map.get(key)!;
  };
  const readiness = record(input.readiness);
  const checks = Array.isArray(readiness.checks) ? readiness.checks : [];
  const timestamp = z
    .number()
    .int()
    .min(0)
    .max(8640000000000000)
    .safeParse(readiness.checkedAt);
  const sanitizedChecks = checks.slice(0, 64).flatMap((rawCheck) => {
    const check = record(rawCheck);
    if (
      !["pass", "fail", "unknown", "not_applicable"].includes(
        String(check.status),
      )
    )
      return [];
    const explained = explainReadiness({
      id: typeof check.id === "string" ? check.id : "",
      status: check.status as ReadinessCheck["status"],
      message: "",
      ...(typeof check.reason === "string" &&
      Object.hasOwn(readinessReasons, check.reason)
        ? { reason: check.reason as ReadinessReason }
        : {}),
    });
    if (!explained.reason) return [];
    return [
      {
        reason: explained.reason,
        status: explained.status,
        ...(explained.status === "pass" || explained.status === "not_applicable"
          ? {}
          : { nextAction: readinessReasons[explained.reason].nextAction }),
      },
    ];
  });
  return {
    version: 1,
    measurementKind,
    physicalAcceptance: false,
    clockPolicy:
      "Durations use one process and correlation. TTS stages require one explicit playback generation; other stages require one capture generation. UTC entries are observations; cross-process deltas are unavailable.",
    invalidCount,
    uncorrelatedCount,
    overflowCount,
    metrics,
    eventLoopLag: {
      durationKind: "process_local_monotonic" as const,
      sampleCount: loopLag.length,
      ...quantiles(loopLag),
    },
    unmeasured: [
      "native_tool_internals",
      "model_inference_without_host_instrumentation",
      "handset_audibility",
      "handset_screen_visibility",
    ],
    readiness: {
      ...(timestamp.success ? { checkedAt: timestamp.data } : {}),
      checks: sanitizedChecks,
      omittedCount: checks.length - sanitizedChecks.length,
    },
    timeline: events.map((event) => ({
      process: label(processes, event.processId, "p"),
      correlation: label(correlations, event.correlationId, "c"),
      generation: event.generation,
      ...(event.playbackGeneration !== undefined
        ? { playbackGeneration: event.playbackGeneration }
        : {}),
      sequence: event.sequence,
      stage: event.event,
      elapsedMs: event.elapsedMs,
      ...(event.at ? { observedAtUtc: event.at } : {}),
    })),
  };
}

/** Fixed synthetic benchmark; no clock, configuration, transport or model access. */
export function inspectionFixture() {
  const processId = "a".repeat(32);
  return {
    conversationTimeline: {
      version: 1,
      processId,
      events: [100, 200, 300, 400, 500].flatMap((duration, index) => [
        {
          sequence: index * 2 + 1,
          event: "callback_accepted",
          correlationId: index.toString(16).padStart(24, "0"),
          elapsedMs: index * 1000,
          at: "2026-11-13T12:00:00Z",
        },
        {
          sequence: index * 2 + 2,
          event: "agent_acknowledged",
          correlationId: index.toString(16).padStart(24, "0"),
          elapsedMs: index * 1000 + duration,
          at: "2026-11-13T12:00:00Z",
        },
      ]),
    },
  };
}
