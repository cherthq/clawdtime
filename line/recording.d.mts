export const CONSENT_LINE: string;
export const STOPPED_LINE: string;
export function asksToStopRecording(text: unknown): boolean;
export interface RecordingSettings {
  on: boolean;
  code?: string;
  root?: string;
  days?: number;
  video?: boolean;
  line?: string;
  ffmpeg?: string;
}
export function recordingSettings(
  env?: Record<string, string | undefined>,
  options?: { home?: string; repo?: string },
): RecordingSettings;
export interface CallRecording {
  state(): string;
  instructions: string;
  consent(): Promise<boolean>;
  attach(session: unknown, audio?: unknown): void;
  tools(
    tool: (definition: any) => any,
    binding?: { cancel?: () => void },
  ): any[];
  stop(): Promise<void>;
  close(reason?: string): Promise<void>;
}
export function makeCallRecording(options: {
  settings?: RecordingSettings;
  room: unknown;
  callerIdentity: string;
  callStarted?: number;
  media?: Record<string, unknown>;
  spawn?: (...args: any[]) => any;
  synthesize?: (text: string) => AsyncIterable<unknown>;
  ffmpegReady?: (command: string) => boolean;
  interval?: (run: () => void, ms: number) => () => void;
  now?: () => number;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}): CallRecording | null;
