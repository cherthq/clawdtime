// Types for the parts of presentation-source.mjs that the backend tests use.
export type RegionReply =
  | {
      code: "found";
      match: "element" | "window";
      region: { x: number; y: number; w: number; h: number };
    }
  | { code: "no_look" | "no_match" | "unavailable" };
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
