export interface WindowBinding {
  callId: string;
  taskId: string;
  driverGeneration: string;
  processIdentity: string;
  windowId: string;
  geometryGeneration: string;
  expiresAt: number;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface WorkFrame extends Omit<WindowBinding, "expiresAt"> {
  id: string;
  capturedAt: number;
  pixelWidth: number;
  pixelHeight: number;
  windowWidth: number;
  windowHeight: number;
  overlay: "included" | "excluded" | "unknown";
}
export interface WorkAction extends WindowBinding {
  observationId: string;
  coordinates: "points" | "pixels";
  phase: "action" | "typing";
  bounds: Rect;
  cursor: { x: number; y: number };
}
export type PresentationLayout =
  | { visible: false; reason: string; cursor: null }
  | {
      visible: true;
      validUntil: number;
      frameId: string;
      crop: Rect;
      contentRect: Rect;
      cursor: { x: number; y: number; label: string } | null;
      cursorStatus: string;
    };
export class WindowPresentation {
  constructor(options?: {
    zoom?: number;
    transitionMs?: number;
    maxFrameAgeMs?: number;
  });
  bind(binding: WindowBinding): void;
  revoke(): void;
  hide(reason: string): false;
  observe(frame: WorkFrame, now: number): boolean;
  focus(action: WorkAction, now: number): boolean;
  overview(enabled: boolean, now: number): void;
  complete(now: number): void;
  layout(
    now: number,
    output: { width: number; height: number },
  ): PresentationLayout;
}
