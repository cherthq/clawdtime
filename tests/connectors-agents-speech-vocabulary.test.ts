import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoardFeed } from "../connectors/agents/feed.js";
import { Memory } from "../connectors/agents/memory.js";
import {
  namesIn,
  recentPlaces,
  speechVocabulary,
  transcribe,
  vocabularyLimit,
  vocabularyPrompt,
} from "../connectors/agents/speech.js";
import { ComputerJournal } from "../connectors/computer/journal.js";
import { lessonNotes } from "../connectors/computer/remembered.js";

/**
 * The owner's words for speech to text. A name that the model does not know is
 * written as words that it knows, and the computer worker opens a site that
 * does not exist. Made-up names only: Brightwave stands for the owner's
 * company.
 */
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
const home = () => {
  const path = mkdtempSync(join(tmpdir(), "clawdtime-vocabulary-"));
  roots.push(path);
  return path;
};
const words = (prompt: string) => prompt.split(/\s+/).length;

describe("the vocabulary prompt", () => {
  it("always names ClawdTime and Chert, then the owner's list, their memory, and recent sites and apps", () => {
    expect(vocabularyPrompt()).toBe(
      "Names that may be said: ClawdTime, Chert.",
    );
    expect(
      vocabularyPrompt({
        owner: " Brightwave , Ledgerly,, chert ",
        facts: [
          "The owner's company is Brightwave, at brightwave.co.",
          "Vocabulary: Harbor Lane, Quill Studio",
          "Sam Rivera runs the support desk.",
        ],
        places: ["brightwave.co", "Slack", "Google Chrome"],
      }),
    ).toBe(
      "Names that may be said: ClawdTime, Chert, Brightwave, Ledgerly, Harbor Lane, Quill Studio, brightwave.co, Sam Rivera, Slack, Google Chrome.",
    );
  });

  it("reads names from a sentence, never the words of a quoted request", () => {
    expect(
      namesIn(
        'For the request "open brightwave5.co", the owner said: Brightwave bro. I use Slack and Notes.',
      ),
    ).toEqual(["Brightwave", "Slack", "Notes"]);
    expect(namesIn("My sister Ada lives in Pune.")).toEqual(["Ada", "Pune"]);
    expect(namesIn("notes.txt is a file, ledgerly.com is a site")).toEqual([
      "ledgerly.com",
    ]);
  });

  it("never holds a secret: a value shaped like one is dropped, and a fact that speaks of one is left out whole", () => {
    const prompt = vocabularyPrompt({
      owner:
        "Brightwave, sk-abcdefghijklmnop1234, hunter22, AKIAABCDEFGHIJKLMNOP, 4821",
      facts: [
        "The Ledgerly password is hunter22.",
        "Orchard Bank pin is 4821",
        "token: ghp_abcdefghijklmnopqrstuvwxyz0123",
        "Quill is the editor.",
      ],
      places: ["Otp Vault"],
    });
    expect(prompt).toBe(
      "Names that may be said: ClawdTime, Chert, Brightwave, Quill.",
    );
    for (const secret of ["sk-", "hunter22", "AKIA", "4821", "ghp_"])
      expect(prompt).not.toContain(secret);
    expect(prompt).not.toMatch(/Ledgerly|Orchard|Otp/);
  });

  it("is at most about 60 words", () => {
    const letters = (n: number) =>
      String.fromCharCode(97 + Math.floor(n / 26), 97 + (n % 26));
    const owner = Array.from(
      { length: 100 },
      (_, n) => `Studio ${letters(n)}`,
    ).join(", ");
    const prompt = vocabularyPrompt({ owner, places: ["Slack"] });
    expect(words(prompt)).toBeLessThanOrEqual(vocabularyLimit);
    expect(words(prompt)).toBeGreaterThan(vocabularyLimit - 5);
    expect(prompt.startsWith("Names that may be said: ClawdTime, Chert,")).toBe(
      true,
    );
  });
});

describe("the vocabulary of this Mac", () => {
  it("reads memory only while it is on, never its episodes, and the sites that loaded", () => {
    const root = home();
    const memory = new Memory(root);
    memory.setEnabled(true);
    memory.remember({ text: "The owner's company is Brightwave." });
    memory.remember({ text: "Vocabulary: Ledgerly" });
    memory.remember({
      text: 'Opened brightwave5.co for the request "Open Bright Five". It was done.',
      kind: "episode",
    });
    const journal = new ComputerJournal(root);
    journal.open("r1", "Open brightwave5.co");
    journal.step("r1", {
      kind: "open_url",
      target: "brightwave5.co",
      outcome: "ok",
    });
    journal.step("r1", {
      kind: "open_url",
      target: "brightwave5.co",
      outcome: "not_loaded",
    });
    journal.step("r1", {
      kind: "open_url",
      target: "www.brightwave.co",
      outcome: "ok",
    });
    journal.step("r1", { kind: "open_app", target: "Slack", outcome: "ok" });
    journal.step("r1", {
      kind: "open_app",
      target: "Notes",
      outcome: "refused",
    });
    expect(recentPlaces(journal.all())).toEqual(["brightwave.co", "Slack"]);
    const env = { CLAWDTIME_VOCABULARY: "Quill" };
    expect(speechVocabulary({ env, memory, journal })).toBe(
      "Names that may be said: ClawdTime, Chert, Quill, Ledgerly, Brightwave, brightwave.co, Slack.",
    );
    memory.setEnabled(false);
    expect(speechVocabulary({ env, memory, journal })).toBe(
      "Names that may be said: ClawdTime, Chert, Quill, brightwave.co, Slack.",
    );
  });

  it("keeps a site whose page did not load out of the memory of a request", () => {
    const [outcome] = lessonNotes({
      goal: "Open brightwave5.co",
      said: [],
      state: "completed",
      reason: "done",
      history: [
        {
          step: 1,
          action: { kind: "open_url", url: "https://brightwave5.co" },
          why: "",
          outcome:
            "ok, the address went to the browser, but the page did not load (the browser shows the site cannot be reached).",
        },
        {
          step: 2,
          action: { kind: "open_url", url: "https://brightwave.co" },
          why: "",
          outcome: "ok",
        },
      ],
    });
    expect(outcome!.text).toBe(
      'Opened brightwave.co for the request "Open brightwave5.co". It was done.',
    );
  });
});

describe("a recording with the vocabulary", () => {
  const recording = () => {
    const file = join(home(), "a.wav");
    writeFileSync(file, Buffer.alloc(4000, 1));
    return file;
  };
  const listening = () => {
    const forms: FormData[] = [];
    const request = (async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/audio/transcriptions")) {
        forms.push(init.body as FormData);
        return new Response(JSON.stringify({ text: "open brightwave" }));
      }
      return new Response(new Uint8Array([1]));
    }) as typeof fetch;
    return { forms, request };
  };
  const settings = (request: typeof fetch) => ({
    key: "k",
    transcribeModel: "t",
    speakModel: "s",
    voice: "v",
    request,
  });

  it("sends the prompt with the recording, and no prompt when there is none", async () => {
    const { forms, request } = listening();
    const prompt = vocabularyPrompt({ owner: "Brightwave" });
    expect(await transcribe(recording(), settings(request), prompt)).toBe(
      "open brightwave",
    );
    expect(forms[0]!.get("prompt")).toBe(
      "Names that may be said: ClawdTime, Chert, Brightwave.",
    );
    await transcribe(recording(), settings(request));
    expect(forms[1]!.has("prompt")).toBe(false);
  });

  it("the panel's recording carries the owner's list, the names in memory and the recent sites", async () => {
    const root = home();
    vi.stubEnv("CLAWDTIME_VOCABULARY", "Quill, sk-abcdefghijklmnop1234");
    const memory = new Memory(root);
    memory.setEnabled(true);
    memory.remember({ text: "The owner's company is Brightwave." });
    const journal = new ComputerJournal(root);
    journal.open("r1", "Open Ledgerly");
    journal.step("r1", {
      kind: "open_url",
      target: "ledgerly.com",
      outcome: "ok",
    });
    const { forms, request } = listening();
    const feed = new BoardFeed({
      root,
      model: null,
      speech: settings(request),
    });
    const folder = feed.chat().voiceDirectory;
    writeFileSync(join(folder, "rec-1.wav"), Buffer.alloc(4000, 1));
    expect((await feed.hear("rec-1.wav")).heard).toBe("open brightwave");
    expect(forms[0]!.get("prompt")).toBe(
      "Names that may be said: ClawdTime, Chert, Quill, Brightwave, ledgerly.com.",
    );
  });
});
