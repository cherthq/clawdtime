/** Bound the complete user instruction before interpretation, logging or effects.
 * Never shorten an instruction: its last clause may negate an earlier action. */
export const userMessageLimit = 2000;
export const userMessageTooLong =
  "That request is longer than 2000 characters. Nothing was started. Please shorten it without removing any constraints.";
