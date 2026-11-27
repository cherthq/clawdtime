import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sharedSignIn } from "../cli/shared-sign-in.js";
import { readPrivateJSON } from "../connectors/shared/private-file.js";

const origin = "https://coordinator.example";
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

function harness(options: { refuse?: Set<string> } = {}) {
  const folder = mkdtempSync(join(tmpdir(), "clawdtime-sign-in-"));
  folders.push(folder);
  const file = join(folder, "shared", "session.json");
  let now = 1_000_000;
  let issued = 0;
  const posts: { path: string; bearer?: string }[] = [];
  const questions: string[] = [];
  const post = async (path: string, _input: unknown, bearer?: string) => {
    posts.push({ path, bearer });
    if (path === "/auth/start") return { challengeId: "challenge" };
    if (path === "/auth/verify")
      return { token: `session-${++issued}`, expiresAt: now + 3_600_000 };
    if (bearer && options.refuse?.has(bearer))
      throw Error("shared_setup_refused");
    return null;
  };
  const ask = async (question: string) => {
    questions.push(question);
    if (question.startsWith("Your own phone")) return "+14155550100";
    if (question.startsWith("Send a sign-in code")) return "yes";
    return "12345678";
  };
  const run = (keep = true) =>
    sharedSignIn({
      origin,
      ask,
      post,
      now: () => now,
      ...(keep
        ? {
            keep: {
              file,
              check: (token: string) =>
                post("/account/pending-call", {}, token),
            },
          }
        : {}),
    });
  return {
    file,
    posts,
    questions,
    run,
    advance: (ms: number) => (now += ms),
    texts: () => posts.filter((p) => p.path === "/auth/start").length,
  };
}

describe("shared prove sign-in", () => {
  it("reuses a still-valid sign-in instead of sending another text", async () => {
    const h = harness();
    expect(await h.run()).toEqual({ token: "session-1" });
    expect(statSync(h.file).mode & 0o777).toBe(0o600);
    h.advance(30 * 60_000);
    const questions = h.questions.length;
    expect(await h.run()).toEqual({ token: "session-1" });
    expect(h.texts()).toBe(1);
    expect(h.questions.length).toBe(questions);
    expect(h.posts.at(-1)).toEqual({
      path: "/account/pending-call",
      bearer: "session-1",
    });
  });

  it("signs in again when the saved sign-in is close to expiry", async () => {
    const h = harness();
    await h.run();
    h.advance(59 * 60_000);
    expect(await h.run()).toEqual({ token: "session-2" });
    expect(h.texts()).toBe(2);
    expect(readPrivateJSON(h.file).value).toEqual(
      expect.objectContaining({ origin, token: "session-2" }),
    );
  });

  it("forgets a refused sign-in and asks before a new text", async () => {
    const h = harness({ refuse: new Set(["session-1"]) });
    await h.run();
    const questions = h.questions.length;
    expect(await h.run()).toEqual({ token: "session-2" });
    expect(h.texts()).toBe(2);
    expect(
      h.questions
        .slice(questions)
        .some((q) => q.startsWith("Send a sign-in code")),
    ).toBe(true);
  });

  it("never reuses a sign-in from another coordinator", async () => {
    const h = harness();
    await h.run();
    const saved = readPrivateJSON(h.file).value as Record<string, unknown>;
    const { writePrivateJSON } =
      await import("../connectors/shared/private-file.js");
    writePrivateJSON(h.file, { ...saved, origin: "https://other.example" });
    expect(await h.run()).toEqual({ token: "session-2" });
    expect(h.texts()).toBe(2);
  });

  it("keeps nothing for pairing and sends nothing without consent", async () => {
    const h = harness();
    expect(await h.run(false)).toEqual({ token: "session-1" });
    expect(readPrivateJSON(h.file).value).toBeNull();
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
