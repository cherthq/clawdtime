/**
 * Which coordinator setup uses, and whether this Mac can use it. The origin
 * is never guessed: it comes from the --coordinator option, then
 * CLAWDTIME_COORDINATOR, then the `coordinator` field of release.json in the
 * package root. Only an https origin is used (http://127.0.0.1 only in tests).
 */
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { sharedOrigin } from "../../connectors/shared/shared-mac.js";

/** The coordinator protocols that this setup speaks. */
export const coordinatorProtocols: readonly number[] = [1];

export type CoordinatorSource = "option" | "environment" | "release";
export type CoordinatorChoice =
  | { kind: "none" }
  | { kind: "invalid"; source: CoordinatorSource }
  | { kind: "origin"; origin: string; source: CoordinatorSource };

/** The release file of a runtime: small, a regular file, read with no link followed. */
export function readReleaseFile(root: string): Record<string, unknown> | null {
  let fd: number;
  try {
    fd = openSync(
      join(root, "release.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16_384) return null;
    const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export function chooseCoordinator(input: {
  option?: string;
  env: Record<string, string | undefined>;
  root: string;
  allowLoopback?: boolean;
}): CoordinatorChoice {
  const release = readReleaseFile(input.root)?.coordinator;
  const named: [CoordinatorSource, string | undefined][] = [
    ["option", input.option],
    ["environment", input.env.CLAWDTIME_COORDINATOR?.trim() || undefined],
    ["release", typeof release === "string" ? release : undefined],
  ];
  for (const [source, raw] of named) {
    if (raw === undefined) continue;
    try {
      return {
        kind: "origin",
        origin: sharedOrigin(raw, input.allowLoopback === true),
        source,
      };
    } catch {
      return { kind: "invalid", source };
    }
  }
  return { kind: "none" };
}

export type CoordinatorHealth =
  | { kind: "ready"; protocol: number; qualified: boolean }
  | { kind: "unavailable" }
  | { kind: "standby" }
  | { kind: "older"; protocol: number | null }
  | { kind: "newer"; protocol: number };

const healthSchema = z
  .object({
    service: z.literal("shared-number"),
    protocol: z.number().int().optional(),
    mode: z.string().max(40).optional(),
    physicalAcceptance: z.boolean().optional(),
    sharedCallsQualified: z.boolean().optional(),
  })
  .passthrough();

/** Reads the coordinator's /health: one bounded GET with no redirect. */
export async function checkCoordinator(
  origin: string,
  request: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<CoordinatorHealth> {
  let body: unknown;
  try {
    const response = await request(`${origin}/health`, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { kind: "unavailable" };
    body = await response.json();
  } catch {
    return { kind: "unavailable" };
  }
  const health = healthSchema.safeParse(body);
  if (!health.success) return { kind: "unavailable" };
  const { protocol, mode } = health.data;
  if (protocol === undefined || protocol < Math.min(...coordinatorProtocols))
    return { kind: "older", protocol: protocol ?? null };
  if (!coordinatorProtocols.includes(protocol))
    return { kind: "newer", protocol };
  if (mode === "standby") return { kind: "standby" };
  return {
    kind: "ready",
    protocol,
    qualified:
      health.data.physicalAcceptance === true &&
      health.data.sharedCallsQualified !== false,
  };
}
