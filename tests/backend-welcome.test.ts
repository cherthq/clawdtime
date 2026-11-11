import { describe, expect, it } from "vitest";
import { welcomeMessage } from "../src/pairing/welcome.js";
describe("same-chat welcome", () => {
  it("welcomes the human and retains an exact copyable instruction with fragment-only credentials", () => {
    const message = welcomeMessage({
      origin: "https://clawdtime.example.test",
      token: "fixture&token",
      deviceId: "fixture/mac",
      displayId: "1",
    });
    expect(message).toContain("Hey! I'm ClawdTime.");
    expect(message).toContain("chat you're already using");
    expect(message).toContain("ask your agent for one test call");
    const link = new URL(
      message.match(/https:\/\/clawdtime\.example\.test\/setup#\S+/)![0],
    );
    expect(link.search).toBe("");
    expect(new URLSearchParams(link.hash.slice(1)).get("token")).toBe(
      "fixture&token",
    );
    expect(new URLSearchParams(link.hash.slice(1)).get("device")).toBe(
      "fixture/mac",
    );
    expect(message).not.toMatch(
      /liked|tapback|call (?:placed|started)|connected successfully/i,
    );
  });
  it.each([
    "https://clawdtime.example.test/path",
    "https://other:secret@clawdtime.example.test",
    "http://public.example.test",
    "javascript:alert(1)",
  ])("rejects an unsafe origin %s", (origin) => {
    expect(() =>
      welcomeMessage({
        origin,
        token: "fixture",
        deviceId: "mac",
        displayId: "1",
      }),
    ).toThrow();
  });
});
