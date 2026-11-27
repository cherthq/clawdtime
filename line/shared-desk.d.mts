// Types for the parts of shared-desk.mjs that the backend tests use.
export const VERIFY_LIMIT_MS: number;
export interface SharedDesk {
  bindCaller(identity: string): Promise<boolean>;
  open(): Promise<boolean>;
  close(): Promise<void>;
  greeting(): string;
  callId: string | undefined;
  video(): unknown;
  ask(text: string, options?: { requestId?: string }): Promise<string>;
  stop(): Promise<string>;
}
export function makeSharedDesk(options: {
  origin: string;
  token: string;
  roomId: string;
  request?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  claim?: boolean;
  end?: ((reason: string) => unknown) | null;
  verifyLimitMs?: number;
}): Promise<SharedDesk>;
