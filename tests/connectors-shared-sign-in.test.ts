import { describe, expect, it } from "vitest";
import { sharedSignIn } from "../cli/shared-sign-in.js";

const origin = "https://coordinator.example";

describe("shared pairing sign-in", () => {
  it("texts a code only after consent and keeps nothing", async () => {
    const posts: string[] = [];
    const session = await sharedSignIn({
      origin,
      ask: async (question) =>
        question.startsWith("Your own phone")
          ? "+14155550100"
          : question.startsWith("Send a sign-in code")
            ? "yes"
            : "12345678",
      post: async (path) => {
        posts.push(path);
        return path === "/auth/start"
          ? { challengeId: "challenge" }
          : { token: "session-1", expiresAt: 1 };
      },
    });
    expect(session).toEqual({ token: "session-1" });
    expect(posts).toEqual(["/auth/start", "/auth/verify"]);
  });

  it("sends nothing without consent", async () => {
    const declined = await sharedSignIn({
      origin,
      ask: async (q) =>
        q.startsWith("Your own phone") ? "+14155550100" : "no",
      post: async () => {
        throw Error("no request expected");
      },
    });
    expect(declined).toBeNull();
  });
});
