import { describe, expect, it } from "vitest";
import { forModel } from "../connectors/agents/chat-agent.js";
import { looksSecretStrict } from "../connectors/computer/journal.js";

const withheld = (text: string, before = "", asked = "") =>
  forModel(text, before, asked) !== text;

describe("words about secrets are not secrets", () => {
  it("lets a rule that forbids keys reach the model", () => {
    for (const text of [
      "Print no key or token anywhere.",
      "Never put a password anywhere in the files.",
      "Keep the secret recipe short and simple.",
      "Read out no token whatsoever.",
    ]) {
      expect(looksSecretStrict(text), text).toBe(false);
      expect(withheld(text), text).toBe(false);
    }
  });

  it("still holds back a value right after a secret word", () => {
    for (const text of [
      "the token ghp_abc123def456",
      "password hunter22",
      "use the api key sk-live-1234abcd",
      'my secret "blue whale"',
    ]) {
      expect(looksSecretStrict(text), text).toBe(true);
    }
  });

  it("lets an answer through that picks an option the question offered", () => {
    const before =
      "Open the page and authorize the token. Do not read out any token.";
    const asked =
      "Which workspace should I authorize: `studio-48213` (selected now) or `home-77120`?";
    expect(withheld("studio-48213", before, asked)).toBe(false);
    expect(withheld("studio-48213.", before, asked)).toBe(false);
  });

  it("still holds back a bare value after words that name a secret", () => {
    expect(withheld("hunter22", "my bank password is")).toBe(true);
    expect(withheld("hunter22", "Type my pin.", "Which field?")).toBe(true);
    expect(
      withheld("studio-48213", "Type my pin.", "Which one: `home-77120`?"),
    ).toBe(true);
  });
});
