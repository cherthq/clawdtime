import { existsSync, lstatSync, readFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import type { Adapter, Pairing } from "../src/contracts.js";
import { validateOrigin } from "../connectors/shared/client.js";
import {
  loadConnection,
  secureRead,
  secureWrite,
  type Connection,
} from "../connectors/shared/state.js";

type Claim = { baseUrl: string; pairing: Pairing; token: string };
interface SetupCheckpoint {
  schemaVersion: 1;
  project: string;
  adapter: Adapter;
  origin: string;
  linkFingerprint: string;
  deviceId: string;
  displayId: string;
  allowView: boolean;
  allowControl: boolean;
  claimIntentAt: number;
  claim?: Claim;
}
export function readSetupLink(file: string, expectedOrigin: string) {
  let url: URL;
  const stat = lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("Setup link must be your own regular private file.");
  chmodSync(file, 0o600);
  try {
    url = new URL(readFileSync(file, "utf8").trim());
  } catch {
    throw new Error(
      "Setup link is invalid; its private contents were not printed.",
    );
  }
  const origin = validateOrigin(expectedOrigin);
  if (
    url.protocol !== "https:" ||
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    !["/setup", "/pair"].includes(url.pathname)
  )
    throw new Error(
      "Setup link must use the explicitly trusted HTTPS origin and /setup path (legacy /pair accepted), with credentials only in its fragment.",
    );
  const params = new URLSearchParams(url.hash.slice(1));
  if (
    [...params.keys()].some(
      (key) =>
        !["token", "device", "display"].includes(key) ||
        params.getAll(key).length !== 1,
    )
  )
    throw new Error("Setup fragment has unexpected or duplicate fields.");
  const token = params.get("token"),
    deviceId = params.get("device"),
    displayId = params.get("display");
  if (
    !token ||
    !deviceId ||
    !displayId ||
    token.length > 4096 ||
    deviceId.length > 200 ||
    displayId.length > 200
  )
    throw new Error(
      "Setup fragment requires token, device and display fields.",
    );
  return {
    origin,
    token,
    deviceId,
    displayId,
    fingerprint: createHash("sha256").update(url.href).digest("hex"),
  };
}
/** One claim attempt, durably recorded before HTTP. Never retry an unknown one-use claim. */
export async function prepareSetup(options: {
  project: string;
  adapter: Adapter;
  connectionFile: string;
  adapterVersion: string;
  setupLinkFile?: string;
  origin?: string;
  existing?: boolean;
  allowView: boolean;
  allowControl: boolean;
  request?: typeof fetch;
}) {
  const checkpointFile = join(
    dirname(options.connectionFile),
    "setup-claim.json",
  );
  const claimFile = join(
    dirname(options.connectionFile),
    "companion-claim.json",
  );
  if (options.existing) {
    const connection = loadConnection(
      options.connectionFile,
      options.project,
      options.adapter,
    );
    if (
      connection.pairing.revokedAt ||
      connection.pairing.allowView !== options.allowView ||
      connection.pairing.allowControl !== options.allowControl
    )
      throw new Error(
        "Existing pairing is revoked or its permissions differ; preserve it and reconcile explicitly.",
      );
    if (options.origin && validateOrigin(options.origin) !== connection.baseUrl)
      throw new Error(
        "Existing connection origin differs from the explicitly trusted origin.",
      );
    if (options.setupLinkFile)
      throw new Error(
        "Choose --existing true or a new setup link, never both.",
      );
    secureWrite(claimFile, {
      baseUrl: connection.baseUrl,
      pairing: connection.pairing,
      token: connection.token,
    });
    return { connection, claimFile, reused: true };
  }
  if (!options.setupLinkFile || !options.origin)
    throw new Error(
      "New setup requires --setup-link-file PRIVATE_FILE and --origin TRUSTED_HTTPS_ORIGIN; use --existing true for an existing pairing.",
    );
  const link = readSetupLink(resolve(options.setupLinkFile), options.origin);
  let checkpoint: SetupCheckpoint;
  if (existsSync(checkpointFile)) {
    checkpoint = secureRead<SetupCheckpoint>(checkpointFile);
    if (
      checkpoint.schemaVersion !== 1 ||
      checkpoint.project !== options.project ||
      checkpoint.adapter !== options.adapter ||
      checkpoint.origin !== link.origin ||
      checkpoint.linkFingerprint !== link.fingerprint ||
      checkpoint.allowView !== options.allowView ||
      checkpoint.allowControl !== options.allowControl
    )
      throw new Error(
        "A different setup checkpoint exists; preserve it and reconcile before a new claim.",
      );
    if (!checkpoint.claim)
      throw new Error(
        "The one-use claim outcome is unknown. Do not claim again; the lead must reconcile the saved intent with the backend.",
      );
  } else {
    if (existsSync(options.connectionFile))
      throw new Error(
        "Existing connection preserved; use --existing true without the setup link.",
      );
    checkpoint = {
      schemaVersion: 1,
      project: options.project,
      adapter: options.adapter,
      origin: link.origin,
      linkFingerprint: link.fingerprint,
      deviceId: link.deviceId,
      displayId: link.displayId,
      allowView: options.allowView,
      allowControl: options.allowControl,
      claimIntentAt: Date.now(),
    };
    secureWrite(checkpointFile, checkpoint);
    let response: Response;
    try {
      response = await (options.request || fetch)(
        `${link.origin}/api/pairing/claim`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token: link.token,
            deviceId: link.deviceId,
            displayId: link.displayId,
            allowView: options.allowView,
            allowControl: options.allowControl,
          }),
          redirect: "error",
          signal: AbortSignal.timeout(12_000),
        },
      );
      if (!response.ok) throw new Error("claim rejected");
      const claim = (await response.json()) as Claim;
      if (
        validateOrigin(claim.baseUrl) !== link.origin ||
        typeof claim.token !== "string" ||
        !claim.token ||
        !claim.pairing?.id ||
        claim.pairing.revokedAt ||
        claim.pairing.deviceId !== link.deviceId ||
        claim.pairing.displayId !== link.displayId ||
        claim.pairing.allowView !== options.allowView ||
        claim.pairing.allowControl !== options.allowControl
      )
        throw new Error("claim mismatch");
      checkpoint.claim = claim;
      secureWrite(checkpointFile, checkpoint);
    } catch {
      throw new Error(
        "Claim did not return a safely stored matching grant. Its saved intent is preserved; do not retry the one-use token. Ask the lead to reconcile.",
      );
    }
  }
  const claim = checkpoint.claim!;
  const connection: Connection = {
    schemaVersion: 1,
    ...claim,
    adapter: options.adapter,
    adapterVersion: options.adapterVersion,
    projectRoot: options.project,
    hostId: hostname(),
  };
  if (existsSync(options.connectionFile)) {
    const prior = loadConnection(
      options.connectionFile,
      options.project,
      options.adapter,
    );
    if (
      prior.pairing.id !== claim.pairing.id ||
      prior.token !== claim.token ||
      prior.baseUrl !== claim.baseUrl
    )
      throw new Error(
        "Connection changed since the claim; preserve it for explicit reconciliation.",
      );
    secureWrite(claimFile, claim);
    return { connection: prior, claimFile, reused: true };
  }
  secureWrite(options.connectionFile, connection);
  secureWrite(claimFile, claim);
  return { connection, claimFile, reused: false };
}
