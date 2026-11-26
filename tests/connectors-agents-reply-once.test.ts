import { describe, expect, it } from "vitest";
import { alreadySaid } from "../connectors/agents/feed.js";

const said = (text: string) => ({ role: "assistant" as const, text, at: 1 });

describe("an answer is written once", () => {
  it("does not write an answer that the task already said, with or without Done", () => {
    const after = [
      said("Reading today's events."),
      said(
        "Done. Calendar showed 0 events today. I quit Calendar without making any changes.",
      ),
    ];
    expect(
      alreadySaid(
        after,
        "Calendar showed 0 events today. I quit Calendar without making any changes.",
      ),
    ).toBe(true);
    expect(alreadySaid(after, "Calendar showed 0 events today.")).toBe(true);
  });

  it("writes an answer that adds something new", () => {
    const after = [said("Done. Calendar showed 0 events today.")];
    expect(
      alreadySaid(after, "Calendar showed 0 events today, and tomorrow has 2."),
    ).toBe(false);
    expect(alreadySaid(after, "Okay.")).toBe(false);
    expect(alreadySaid([], "Calendar showed 0 events today.")).toBe(false);
  });
});
