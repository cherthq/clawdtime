import { expect, it } from "vitest";
import { createRuntime } from "../src/runtime.js";

it("shutdown waits for an in-flight effect and prevents another tick", async () => {
  const runtime = createRuntime({ CLAWDTIME_DATABASE: ":memory:" });
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  runtime.service.drain = async () => {
    calls++;
    started();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  const tick = runtime.tick();
  await entered;
  let stopped = false;
  const stopping = runtime.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release();
  await Promise.all([tick, stopping]);
  await runtime.tick();
  expect(calls).toBe(1);
  expect(runtime.store.state("heartbeat")).toMatchObject({ ok: true });
  runtime.store.close();
});

it("rejects ambiguous protected configuration sources", () => {
  expect(() =>
    createRuntime({
      CLAWDTIME_LIVE_CONFIG: "/private/config.json",
      CLAWDTIME_LIVE_CONFIG_JSON: "{}",
    }),
  ).toThrow("Choose one");
});

it("never includes malformed secret JSON in configuration errors", () => {
  expect(() =>
    createRuntime({
      CLAWDTIME_MODE: "standby",
      CLAWDTIME_DATABASE: ":memory:",
      CLAWDTIME_LIVE_CONFIG_JSON: '{"projectKey":SYNTHETIC_PRIVATE_VALUE}',
    }),
  ).toThrow(
    "Protected configuration must be a valid JSON object; its contents were withheld.",
  );
});

it.each(["null", "false", "0", '""', "[]"])(
  "never substitutes simulation for a live %s config",
  (value) => {
    expect(() =>
      createRuntime({
        CLAWDTIME_MODE: "live",
        CLAWDTIME_LIVE_TRAFFIC: "true",
        CLAWDTIME_DATABASE: ":memory:",
        CLAWDTIME_ORIGIN: "https://clawdtime.example.test",
        CLAWDTIME_OPERATOR_TOKEN: "a".repeat(32),
        CLAWDTIME_MEDIA_TOKEN: "b".repeat(32),
        CLAWDTIME_LIVE_CONFIG_JSON: value,
      }),
    ).toThrow("valid JSON object");
  },
);

it("reports deployed standby distinctly from simulation and live", async () => {
  const runtime = createRuntime({
    CLAWDTIME_MODE: "standby",
    CLAWDTIME_DATABASE: ":memory:",
  });
  expect(await (await runtime.app.request("/health")).json()).toMatchObject({
    mode: "standby",
    physicalAcceptance: false,
  });
  expect(runtime.store.state("runtime:mode")).toBe("standby");
  runtime.store.close();
});
