export const RECORDING_RATE: number;
export const CALL_ID: RegExp;
export const PART_FILE: RegExp;
export function newCallId(at?: number): string;
export function writeJSON(
  file: string,
  value: unknown,
  options?: { sync?: boolean },
): void;
export function readWav(file: string): {
  rate: number;
  channels: number;
  samples: Int16Array;
};
export function pruneRecordings(
  root: string,
  now?: number,
  options?: { fallbackDays?: number },
): string[];
