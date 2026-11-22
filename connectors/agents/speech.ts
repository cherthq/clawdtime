import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
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

/** The words in one short recording. The file is sent once and never kept by this code. */
export async function transcribe(
  file: string,
  settings: SpeechSettings,
): Promise<string> {
  const size = statSync(file).size;
  if (size < 1000) return "";
  if (size > 20 * 1024 * 1024) throw new Error("The recording is too long.");
  const form = new FormData();
  form.set("model", settings.transcribeModel);
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
