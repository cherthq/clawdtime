import type { PresentationLayout } from "../../media/window-presentation.mjs";
export interface BackgroundPreview {
  valid(): boolean;
  rgba: Uint8Array;
  width: number;
  height: number;
  frameId: string;
  capturedAt: number;
  expiresAt: number;
  layout: PresentationLayout;
}
export interface BackgroundPresentationPort {
  preview(callId: string, taskId: string): Promise<BackgroundPreview | null>;
  overview(callId: string, taskId: string, enabled: boolean): void;
}
