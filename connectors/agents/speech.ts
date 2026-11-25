import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import {
  looksBareSecret,
  looksSecretStrict,
  namesSecret,
  type JournalRequest,
} from "../computer/journal.js";
import { webAddress } from "../computer/navigation.js";
import type { MemoryFact } from "./memory.js";
import { userMessageLimit, userMessageTooLong } from "./request-text.js";

/** Speech in and speech out, through the OpenAI audio API. Only a status is ever reported on failure. */
export interface SpeechSettings {
  key: string;
  transcribeModel: string;
  speakModel: string;
  voice: string;
  request?: typeof fetch;
}

export function speechSettings(
  env: Record<string, string | undefined>,
): SpeechSettings | null {
  const key = env.CLAWDTIME_OPENAI_API_KEY || env.OPENAI_API_KEY;
  if (!key) return null;
  return {
    key,
    transcribeModel: env.CLAWDTIME_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
    speakModel: env.CLAWDTIME_SPEAK_MODEL || "gpt-4o-mini-tts",
    voice: env.CLAWDTIME_VOICE || "alloy",
  };
}

/**
 * The owner's words for speech to text. A transcription model writes a name
 * that it does not know as words that it knows: a made-up "Brightwave" can
 * come out as "Bright5.co", and the computer worker then opens a site that
 * does not exist.
 * A short prompt of the names that the owner uses lets the model write them.
 * It holds names only: ClawdTime's own names, the owner's list
 * (`CLAWDTIME_VOCABULARY`, or a memory fact that starts with "Vocabulary:"),
 * the names in the owner's memory facts while memory is on, and the sites and
 * apps that recent computer requests opened. At most `vocabularyLimit` words,
 * and never a word shaped like a secret, or a fact that speaks of one.
 */
export interface VocabularySources {
  /** The owner's list, comma separated: `CLAWDTIME_VOCABULARY`. */
  owner?: string;
  /** The text of the facts in memory. Only while memory is on. */
  facts?: readonly string[];
  /** The names of the sites and apps that recent computer requests opened, newest first. */
  places?: readonly string[];
}
/** ClawdTime's own names: always first. */
export const productNames = ["ClawdTime", "Chert"] as const;
/** The most words of the vocabulary. */
export const vocabularyLimit = 60;
const vocabularyLead = "Names that may be said:";
/** A memory fact that is the owner's list: "Vocabulary: Brightwave, Ledger". */
const listFact = /^\s*vocabulary\s*:\s*(.+)$/i;
/** Capital words that open a sentence and name nothing. */
const plainWords = new Set(
  "a an and as at but by for from he her his how i if in is it its my no not of on or our she so that the their then there these they this to was we were what when where which who why with you your opened worked".split(
    " ",
  ),
);
const unsafe = (text: string) =>
  looksSecretStrict(text) || looksBareSecret(text) || namesSecret(text);

/** One name for the vocabulary, plain and short, or null. */
function plainName(raw: string): string | null {
  const name = raw
    .replace(/\p{C}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  if (!name || name.length > 40 || name.split(" ").length > 4) return null;
  return unsafe(name) ? null : name;
}

/**
 * The names in one sentence of the owner: runs of capital words ("Dana",
 * "Harbor Lane Studio") and web addresses ("brightwave.co"). A quoted part is left
 * out: a note of memory quotes a request, and that may be the misheard words.
 */
export function namesIn(text: string): string[] {
  const plain = text.replace(/"[^"]*"|\u201c[^\u201d]*\u201d/g, " ");
  const found: string[] = [];
  for (const word of plain.split(/\s+/)) {
    const address = webAddress(word);
    if (address && !address.fileLike)
      found.push(address.url.hostname.replace(/^www\./, ""));
  }
  const capital =
    /(?<![\p{L}\p{N}.@/])\p{Lu}[\p{L}\p{N}'&-]*(?:\s+\p{Lu}[\p{L}\p{N}'&-]*){0,2}/gu;
  for (const match of plain.matchAll(capital)) {
    const words = match[0].split(/\s+/);
    while (words.length && plainWords.has(words[0]!.toLowerCase()))
      words.shift();
    if (words.length) found.push(words.join(" ").replace(/'s$/, ""));
  }
  return found;
}

/** The vocabulary prompt for the transcription model. ClawdTime's own names at the least. */
export function vocabularyPrompt(sources: VocabularySources = {}): string {
  const facts = (sources.facts ?? []).filter((fact) => !unsafe(fact));
  const listed = [
    ...(sources.owner ?? "").split(","),
    ...facts.flatMap((fact) => listFact.exec(fact)?.[1]?.split(",") ?? []),
  ];
  const named = facts
    .filter((fact) => !listFact.test(fact))
    .flatMap((fact) => namesIn(fact));
  const names: string[] = [];
  const seen = new Set<string>();
  let words = vocabularyLead.split(" ").length;
  for (const raw of [
    ...productNames,
    ...listed,
    ...named,
    ...(sources.places ?? []),
  ]) {
    const name = plainName(raw);
    if (!name || seen.has(name.toLowerCase())) continue;
    const size = name.split(" ").length;
    if (words + size > vocabularyLimit) break;
    seen.add(name.toLowerCase());
    names.push(name);
    words += size;
  }
  return `${vocabularyLead} ${names.join(", ")}.`;
}

/**
 * The sites and apps that recent computer requests opened, newest first. A
 * site whose page did not load (`not_loaded` in the journal) is left out: it
 * may be a misheard name.
 */
export function recentPlaces(
  requests: readonly JournalRequest[],
  limit = 10,
): string[] {
  const places: string[] = [];
  for (const request of requests.slice(-limit).reverse()) {
    const failed = new Set(
      request.steps
        .filter((step) => step.outcome === "not_loaded")
        .map((step) => step.target.toLowerCase()),
    );
    for (const step of request.steps)
      if (
        ["open_url", "browser_open", "open_app"].includes(step.kind) &&
        step.outcome === "ok" &&
        step.target &&
        !failed.has(step.target.toLowerCase())
      )
        places.push(step.target.replace(/^www\./, ""));
  }
  return places;
}

/** The vocabulary of this Mac: the owner's list, their memory while it is on, and recent computer requests. */
export function speechVocabulary(from: {
  env: Record<string, string | undefined>;
  memory?: { enabled(): boolean; facts(): MemoryFact[] };
  journal?: { all(): JournalRequest[] };
}): string {
  let facts: string[] = [];
  try {
    if (from.memory?.enabled())
      facts = from.memory
        .facts()
        .filter((fact) => fact.current && fact.kind !== "episode")
        .map((fact) => fact.text);
  } catch {
    facts = [];
  }
  let places: string[] = [];
  try {
    places = recentPlaces(from.journal?.all() ?? []);
  } catch {
    places = [];
  }
  return vocabularyPrompt({
    owner: from.env.CLAWDTIME_VOCABULARY,
    facts,
    places,
  });
}

/**
 * The words in one short recording. The file is sent once and never kept by
 * this code. A vocabulary prompt (`vocabularyPrompt`) goes with it when one
 * is given.
 */
export async function transcribe(
  file: string,
  settings: SpeechSettings,
  vocabulary = "",
): Promise<string> {
  const size = statSync(file).size;
  if (size < 1000) return "";
  if (size > 20 * 1024 * 1024) throw new Error("The recording is too long.");
  const form = new FormData();
  form.set("model", settings.transcribeModel);
  if (vocabulary) form.set("prompt", vocabulary);
  form.set("file", new Blob([readFileSync(file)]), basename(file));
  const response = await (settings.request ?? fetch)(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { authorization: `Bearer ${settings.key}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok)
    throw new Error(`Transcription answered ${response.status}.`);
  const body = (await response.json()) as { text?: unknown };
  if (typeof body.text !== "string") return "";
  if (body.text.length > userMessageLimit) throw new Error(userMessageTooLong);
  return body.text.replace(/\p{C}/gu, " ").trim();
}

/** The answer as speech: the bytes of one MP3. */
export async function speak(
  text: string,
  settings: SpeechSettings,
): Promise<Buffer> {
  const response = await (settings.request ?? fetch)(
    "https://api.openai.com/v1/audio/speech",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${settings.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: settings.speakModel,
        voice: settings.voice,
        input: text.slice(0, 1200),
        response_format: "mp3",
      }),
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok) throw new Error(`Speech answered ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
}
