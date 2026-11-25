import { describe, expect, it } from "vitest";
import { forModel } from "../connectors/agents/chat-agent.js";
import { looksSecretStrict } from "../connectors/computer/journal.js";

describe("a long number inside a link is no card", () => {
  it("lets links with long message, order or file numbers through", () => {
    for (const text of [
      "Open this link: https://team.example.com/archives/C0ABC123/p1795625515736179 and reply in its thread.",
      "Read https://shop.example/orders/4532123456789010/receipt and tell me the total.",
      "Open the post at x.example/status/1987654321098765432 please.",
    ]) {
      expect(looksSecretStrict(text), text).toBe(false);
      expect(forModel(text), text).toBe(text);
    }
  });

  it("still holds back a card number written out", () => {
    for (const text of [
      "my card number is 4532 1234 5678 9010",
      "card 4532-1234-5678-9010",
      "use 4111111111111111 to pay",
      "pay with 4111111111111111, it is in https://pay.example/checkout",
    ]) {
      expect(looksSecretStrict(text), text).toBe(true);
    }
  });
});
