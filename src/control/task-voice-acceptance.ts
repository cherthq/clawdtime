// This grammar identifies assent only; the caller must still verify the exact
// connected review, finalized utterance, run, revision and independent checks.
// Match the entire utterance so a compliment cannot swallow a requested change,
// condition, negation or quoted/reported approval.
const discourse = "(?:(?:okay|ok|yes|yeah|alright|sure|well)[\\s,.!]+){0,2}";
const explicit =
  "(?:I (?:accept|approve) (?:the |this )?result|(?:accept|approve) (?:the |this )result)";
const positive =
  "(?:I think )?(?:(?:it|that|this|the result) )?looks good(?: to me)?";
const courtesy = "(?:[\\s,.!]+(?:thanks|thank you|please))?";
const acceptance = new RegExp(
  `^${discourse}(?:${explicit}|${positive})${courtesy}[.!]*$`,
  "i",
);

export function isTaskResultAcceptance(text: string): boolean {
  return acceptance.test(text.replace(/\s+/g, " ").trim());
}
