import { afterEach, describe, expect, it } from "vitest";
import { childEnvironment } from "../cli/task-desktop.js";

const keys = [
  "CLAWDTIME_COMPUTER_TRUST",
  "CLAWDTIME_COMPUTER_REACH",
  "CLAWDTIME_COMPUTER_REACH_SECONDS",
  "CLAWDTIME_OWN_BROWSER_PATH",
  "CLAWDTIME_VOCABULARY",
  "SOMETHING_ELSE",
];
const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of keys)
    if (before[key] === undefined) delete process.env[key];
    else process.env[key] = before[key];
});

describe("the environment that the desktop launcher passes to the service", () => {
  it("passes the owner's trust, the reach, the path of the own browser and the owner's vocabulary, and nothing else", () => {
    process.env.CLAWDTIME_COMPUTER_TRUST = "on";
    process.env.CLAWDTIME_COMPUTER_REACH = "off";
    process.env.CLAWDTIME_COMPUTER_REACH_SECONDS = "30";
    process.env.CLAWDTIME_OWN_BROWSER_PATH = "/Applications/Chrome.app";
    process.env.CLAWDTIME_VOCABULARY = "Brightwave, ClawdTime";
    process.env.SOMETHING_ELSE = "x";
    const env = childEnvironment();
    expect(env.CLAWDTIME_COMPUTER_TRUST).toBe("on");
    expect(env.CLAWDTIME_COMPUTER_REACH).toBe("off");
    expect(env.CLAWDTIME_COMPUTER_REACH_SECONDS).toBe("30");
    expect(env.CLAWDTIME_OWN_BROWSER_PATH).toBe("/Applications/Chrome.app");
    expect(env.CLAWDTIME_VOCABULARY).toBe("Brightwave, ClawdTime");
    expect(env.SOMETHING_ELSE).toBeUndefined();
  });
});
