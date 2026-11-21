import type {
  CaptureBinding,
  DriverImageResult,
  CaptureResult,
  OverlayQualification,
} from "./driver-window-source.mjs";
import type { WorkAction, PresentationLayout } from "./window-presentation.mjs";
export interface WindowPreviewRequest {
  readonly session: string;
  readonly pid: number;
  readonly window_id: number;
  readonly include_accessibility_tree: false;
  readonly include_screenshot: true;
  readonly display_only: true;
  readonly screenshot_format: "jpeg";
  readonly screenshot_quality: 85;
  readonly max_dimension: 1280;
  readonly timeout_ms: 1000;
}
export interface WindowVideoView {
  frameId: string;
  capturedAt: number;
  width: number;
  height: number;
  rgba: Uint8Array;
  layout: Extract<PresentationLayout, { visible: true }>;
}
export type WindowVideoTick =
  | Exclude<CaptureResult, { status: "frame" }>
  | { status: "frame"; frameId: string; capturedAt: number; durationMs: number }
  | { status: "superseded" | "source_changed" };
export class BackgroundWindowVideo {
  constructor(options: {
    captureWindow: (
      request: WindowPreviewRequest,
    ) => Promise<DriverImageResult>;
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
    zoom?: number;
    transitionMs?: number;
  });
  bind(binding: CaptureBinding): void;
  tick(): Promise<WindowVideoTick>;
  focus(action: WorkAction): boolean;
  overview(enabled?: boolean): void;
  complete(): void;
  revoke(): void;
  status(): string;
  latest(output: { width: number; height: number }): WindowVideoView | null;
  isCurrent(view: WindowVideoView): boolean;
}
