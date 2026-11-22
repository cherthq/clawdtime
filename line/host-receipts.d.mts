export interface HostLogBoundary {
  device: number;
  inode: number;
  offset: number;
}
export type HostStopReceipt =
  | { state: "released"; retained: 0; offset: number }
  | { state: "waiting" | "unknown"; reason: string };
export function hostLogBoundary(path: string): HostLogBoundary;
export function hostStopReceipt(
  path: string,
  boundary: HostLogBoundary,
): HostStopReceipt;
