/**
 * Computer use: the few LiveKit server calls that a call of the reach needs,
 * over fetch, with no LiveKit package.
 *
 * - `liveKitToken` makes an access token: a JSON Web Token signed with HMAC
 *   SHA-256 over the API key and secret of the LiveKit project. It always has
 *   an end, and at most two hours.
 * - `LiveKitRooms` makes a room, sends an agent into it, reads who is in it,
 *   sets its metadata and removes it, through the server API of the project.
 *   Each request carries its own token, for that one room and one minute.
 *
 * Nothing here prints or keeps the secret. An error says only the HTTP status
 * or that no answer came.
 */
import { createHmac } from "node:crypto";

/** The rights of one token, in the names of LiveKit. */
export interface VideoGrant {
  roomCreate?: boolean;
  roomAdmin?: boolean;
  roomJoin?: boolean;
  room?: string;
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
}

/** The longest life of a token: two hours, from its start to its end. */
export const tokenLifetimeLimit = 7200;
/** The start of a token lies this many seconds before now. */
export const notBeforeLead = 30;

const base64url = (value: Buffer | string) =>
  Buffer.from(value).toString("base64url");

/** A signed access token of the LiveKit project. */
export function liveKitToken(input: {
  apiKey: string;
  apiSecret: string;
  grant: VideoGrant;
  /** Seconds from now, 1 to 7200. */
  ttlSeconds: number;
  identity?: string;
  name?: string;
  now?: number;
}): string {
  if (!input.apiKey || !input.apiSecret)
    throw new Error("livekit_keys_missing");
  if (
    !Number.isInteger(input.ttlSeconds) ||
    input.ttlSeconds < 1 ||
    input.ttlSeconds + notBeforeLead > tokenLifetimeLimit
  )
    throw new Error("livekit_token_lifetime_invalid");
  if (input.grant.roomJoin && !input.identity)
    throw new Error("livekit_token_identity_missing");
  const issued = Math.floor((input.now ?? Date.now()) / 1000);
  const claims = {
    iss: input.apiKey,
    // A little before now: a server whose clock is behind still takes it.
    nbf: issued - notBeforeLead,
    exp: issued + input.ttlSeconds,
    ...(input.identity ? { sub: input.identity } : {}),
    ...(input.name ? { name: input.name } : {}),
    video: input.grant,
  };
  const head = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(claims));
  const signature = createHmac("sha256", input.apiSecret)
    .update(`${head}.${body}`)
    .digest("base64url");
  return `${head}.${body}.${signature}`;
}

/** The address of the server API for a project address: wss:// becomes https://. */
export function liveKitApiOrigin(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "wss:" && parsed.protocol !== "https:")
    throw new Error("livekit_url_not_encrypted");
  if (parsed.username || parsed.password)
    throw new Error("livekit_url_invalid");
  return `https://${parsed.host}`;
}

/** A refusal or a lost answer of the server API. `status` is null when no answer came. */
export class LiveKitError extends Error {
  constructor(readonly status: number | null) {
    super(status === null ? "livekit_no_answer" : `livekit_http_${status}`);
    this.name = "LiveKitError";
  }
}

/** One participant of a room, as the server API gives it. Only what the reach reads. */
export interface RoomParticipant {
  identity: string;
  tracks: { type: "audio" | "video" | "other"; muted: boolean }[];
}

/** What a call of the reach asks of LiveKit. Tests give a fake one. */
export interface LiveKitPort {
  createRoom(
    room: string,
    options: {
      emptyTimeout: number;
      departureTimeout: number;
      maxParticipants: number;
      metadata: string;
    },
  ): Promise<void>;
  /** Sends the agent of that name into the room, with its job metadata. */
  dispatch(room: string, agentName: string, metadata: string): Promise<void>;
  participants(room: string): Promise<RoomParticipant[]>;
  setMetadata(room: string, metadata: string): Promise<void>;
  deleteRoom(room: string): Promise<void>;
}

/** The kind of a track in the JSON of the server API: a name or a number. Audio is 0. */
const trackType = (value: unknown): "audio" | "video" | "other" => {
  if (value === undefined || value === null || value === 0 || value === "AUDIO")
    return "audio";
  if (value === 1 || value === "VIDEO") return "video";
  return "other";
};

/** The server API of one LiveKit project. */
export class LiveKitRooms implements LiveKitPort {
  private readonly origin: string;
  constructor(
    private readonly settings: {
      url: string;
      apiKey: string;
      apiSecret: string;
    },
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.origin = liveKitApiOrigin(settings.url);
  }

  private async call(
    service: "RoomService" | "AgentDispatchService",
    method: string,
    body: Record<string, unknown>,
    grant: VideoGrant,
  ): Promise<Record<string, unknown>> {
    const token = liveKitToken({
      apiKey: this.settings.apiKey,
      apiSecret: this.settings.apiSecret,
      grant,
      ttlSeconds: 60,
      now: this.now(),
    });
    let response: Response;
    try {
      response = await this.request(
        `${this.origin}/twirp/livekit.${service}/${method}`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
    } catch {
      throw new LiveKitError(null);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new LiveKitError(response.status);
    }
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new LiveKitError(response.status);
    if (!text.trim()) return {};
    try {
      const value: unknown = JSON.parse(text);
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    } catch {
      throw new LiveKitError(response.status);
    }
  }

  async createRoom(
    room: string,
    options: {
      emptyTimeout: number;
      departureTimeout: number;
      maxParticipants: number;
      metadata: string;
    },
  ) {
    await this.call(
      "RoomService",
      "CreateRoom",
      { name: room, ...options },
      { roomCreate: true },
    );
  }
  async dispatch(room: string, agentName: string, metadata: string) {
    await this.call(
      "AgentDispatchService",
      "CreateDispatch",
      { room, agentName, metadata },
      { roomAdmin: true, room },
    );
  }
  async participants(room: string): Promise<RoomParticipant[]> {
    const value = await this.call(
      "RoomService",
      "ListParticipants",
      { room },
      { roomAdmin: true, room },
    );
    const rows = Array.isArray(value.participants) ? value.participants : [];
    return rows.slice(0, 16).map((row) => {
      const item = (row ?? {}) as Record<string, unknown>;
      const tracks = Array.isArray(item.tracks) ? item.tracks : [];
      return {
        identity: typeof item.identity === "string" ? item.identity : "",
        tracks: tracks.slice(0, 16).map((track) => {
          const entry = (track ?? {}) as Record<string, unknown>;
          return { type: trackType(entry.type), muted: entry.muted === true };
        }),
      };
    });
  }
  async setMetadata(room: string, metadata: string) {
    await this.call(
      "RoomService",
      "UpdateRoomMetadata",
      { room, metadata },
      { roomAdmin: true, room },
    );
  }
  async deleteRoom(room: string) {
    await this.call(
      "RoomService",
      "DeleteRoom",
      { room },
      { roomCreate: true },
    );
  }
}
