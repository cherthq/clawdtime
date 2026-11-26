export interface ProactiveBinding {
  attemptId: string;
  roomName: string;
  agentIdentity: string;
  sourceFingerprint: string;
  packetFingerprint: string;
}
export interface ProactiveConfig extends ProactiveBinding {
  version: 1;
  origin: string;
  token: string;
  expiresAt: number;
  providerCallerIdentity: string;
}
export interface ProactiveRuntimeState extends ProactiveBinding {
  authorized: boolean;
  channel: "phone_alert" | "phone_walkthrough";
  providerCallerIdentity: string | null;
  narration: string;
  question?: string;
  message?: string;
  expiresAt: number;
  sharingAllowed: boolean;
  computerAllowed?: boolean;
  ended?: boolean;
}
export interface ProactiveFrame {
  attemptId: string;
  sourceFingerprint: string;
  packetFingerprint: string;
  viewId: string;
  frameId: string;
  width: number;
  height: number;
  capturedAt: number;
  expiresAt: number;
  layout: unknown;
  rgba: Uint8Array;
}
export interface ProactiveCallClient {
  binding: ProactiveBinding;
  prepared(
    roomName: string,
    agentIdentity: string,
  ): Promise<ProactiveRuntimeState>;
  status(): Promise<ProactiveRuntimeState>;
  bindCaller(identity: string): Promise<boolean>;
  active(): boolean;
  snapshot(): ProactiveRuntimeState | null;
  answer(text: string, context?: { requestId?: string }): Promise<string>;
  stopSharing(): Promise<string>;
  computer(text: string, context?: { requestId?: string }): Promise<string>;
  stopComputer(): Promise<string>;
  windowFrame(): Promise<ProactiveFrame | null>;
  greeting(): string;
  close(): Promise<unknown>;
}
export function readProactiveConfig(path: string): ProactiveConfig;
export function createProactiveCallClient(
  config: ProactiveConfig,
  ports?: {
    request?: typeof fetch;
    clock?: () => number;
    onRevoked?: () => void;
  },
): ProactiveCallClient;
export interface ProactiveMediaConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
  agentName: string;
  roomName: string;
  agentIdentity: string;
  providerCallerIdentity: string;
  attemptId: string;
  expiresAt: number;
}
export interface ProactiveMediaPorts {
  reserveEffect(stage: "room_create" | "room_delete"): Promise<unknown>;
  recordEffect(
    stage: "room_create" | "room_delete",
    outcome: "confirmed" | "unknown",
  ): Promise<unknown>;
  authorize(): Promise<void>;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  roomService?: {
    createRoom(input: unknown): Promise<unknown>;
    listParticipants(name: string): Promise<any[]>;
    deleteRoom(name: string): Promise<unknown>;
    listRooms(names: string[]): Promise<any[]>;
  };
}
export interface ProactiveOutboundMedia {
  prepare(): Promise<{
    credentials: {
      livekit_url: string;
      participant_token: string;
      remote_participant_identity: string;
    };
    publications: { audio: string; video: string };
  }>;
  inspect(): Promise<any[]>;
  close(): Promise<{ closed: boolean; created?: boolean }>;
}
export function createProactiveOutboundMedia(
  config: ProactiveMediaConfig,
  ports: ProactiveMediaPorts,
): Promise<ProactiveOutboundMedia>;
