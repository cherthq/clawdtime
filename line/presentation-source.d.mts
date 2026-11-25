// Types for the parts of presentation-source.mjs that the backend tests use.
export type RegionReply =
  | {
      code: "found";
      match: "element" | "window";
      region: { x: number; y: number; w: number; h: number };
    }
  | { code: "no_look" | "no_match" | "unavailable" };
export interface DesktopViewReply {
  view: { x: number; y: number; w: number; h: number } | null;
  at: number;
}
export interface PresentationEventOptions {
  immediate?: boolean;
}
export function startPresentation(options: {
  since: number;
  onEvent: (event: unknown, options?: PresentationEventOptions) => void;
  env?: Record<string, string | undefined>;
  home?: string;
  pollMs?: number;
  timeoutMs?: number;
  now?: () => number;
  request?: (url: string, init: RequestInit) => Promise<Response>;
  discover?: () => {
    origin: string;
    instanceId: string;
    token: string;
  } | null;
  automatic?: boolean;
}): { check(): Promise<void>; stop(): void };
export function validRegionAnswer(answer: unknown): RegionReply | null;
export function requestRegion(
  name: string,
  options?: {
    env?: Record<string, string | undefined>;
    home?: string;
    timeoutMs?: number;
    request?: (url: string, init: RequestInit) => Promise<Response>;
    discover?: () => {
      origin: string;
      instanceId: string;
      token: string;
    } | null;
  },
): Promise<RegionReply>;
export function requestView(options?: {
  env?: Record<string, string | undefined>;
  home?: string;
  timeoutMs?: number;
  request?: (url: string, init: RequestInit) => Promise<Response>;
  discover?: () => {
    origin: string;
    instanceId: string;
    token: string;
  } | null;
}): Promise<DesktopViewReply | null>;
