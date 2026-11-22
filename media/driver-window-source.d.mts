import type { WindowBinding, WorkFrame } from "./window-presentation.mjs";
export interface CaptureBinding extends WindowBinding {
  pid: number;
  session: string;
}
export interface DriverImageResult {
  isError: boolean;
  degraded?: boolean;
  structuredJson?: string;
  images: Array<{ mimeType: string; dataBase64: string }>;
}
export class WindowCaptureError extends Error {
  code: string;
  constructor(code: string);
}
export function decodeWindowPreview(
  result: DriverImageResult,
  expected: { pid: number; windowId: string },
): {
  rgba: Uint8Array;
  width: number;
  height: number;
  windowWidth: number;
  windowHeight: number;
  overlay: "unknown";
};
export type CaptureResult =
  | { status: "frame"; rgba: Uint8Array; durationMs: number; frame: WorkFrame }
  | {
      status:
        | "not_authorized"
        | "capture_in_progress"
        | "rate_limited"
        | "target_unavailable"
        | "stale_capture"
        | "capture_timeout";
    }
  | { status: "capture_error"; code: string };
export interface OverlayQualification {
  driverVersion: "0.55.0";
  artifactSha256: "faf11948f8f9b410a76750e65ae14cb1d95cc321aa61fc158f70de8a68c270b1";
  driverGeneration: string;
  osBuild: string;
  capturePipeline: "get_window_state/jpeg/display_only";
  qualificationId: string;
  result: "excluded";
  qualifiedAt: number;
  expiresAt: number;
}
export class DriverWindowSource {
  constructor(options: {
    callTool: (name: string, args: string) => Promise<DriverImageResult>;
    verifyBinding: (
      binding: CaptureBinding,
    ) =>
      | { valid: boolean; onCurrentSpace: boolean }
      | Promise<{ valid: boolean; onCurrentSpace: boolean }>;
    clock?: () => number;
    monotonicClock?: () => number;
    fps?: number;
    maxFrameAgeMs?: number;
    overlayQualification?: OverlayQualification;
  });
  bind(binding: CaptureBinding): void;
  revoke(): void;
  next(): Promise<CaptureResult>;
}
