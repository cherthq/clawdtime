# Independent deployment and operations

No ClawdTime remote service, domain, npm package or GitHub remote was provisioned
in this implementation session. The local application and three component builds
are available. Apple Teams services remain unchanged. External deployment requires
existing authorized hosting capacity, new service names and new persistent volumes.
Do not deploy these artifacts to Apple Teams service IDs.

## Backend

Node 24+, `npm ci && npm run build`, then `npm start`. The root Dockerfile provides
a separate non-root Node service. Mount an empty dedicated persistent `/data`
volume, one replica, no overlapping deployment processes. Set `CLAWDTIME_ORIGIN`
to the fixed HTTPS backend origin. Use `CLAWDTIME_MODE=standby` initially. Standby
hosts onboarding/health but does not ingest new Messages or dispatch new calls or
completion messages. `/health` is process health; authenticated
`/internal/readiness` reports pending/unknown effects and active calls, not physical
readiness. Keep the SQLite WAL and unknown effects, never reset them to force progress.

Use fresh, distinct 32+ character operator/media keys, supplied through the host
secret store, never Docker build args. `CLAWDTIME_OPERATOR_TOKEN` protects internal
operator routes; `CLAWDTIME_MEDIA_TOKEN` is shared only with the media service.
Default local port is 3310. No key means corresponding protected routes refuse access.

## Native transport configuration

`CLAWDTIME_LIVE_CONFIG` is an owner-only 0600 JSON file mounted read-only. It matches
`NativeTransportConfig` in `src/transport/native.ts`, plus `testers` in runtime.ts.
It contains existing supported native transport access, fresh media and encryption
keys, and the explicit handoff attestation. Never copy an Apple Teams environment
file wholesale. Operator provisions only the required scoped transport credentials.

Shape (placeholders only):

```json
{
  "enabled": true,
  "binding": {
    "origin": "https://NATIVE",
    "token": "SECRET",
    "signingSecret": "SECRET",
    "lineId": "LOGICAL_UUID",
    "providerLineId": "NATIVE_ID",
    "phone": "PRIVATE_E164",
    "instanceId": "NATIVE_INSTANCE"
  },
  "callsOrigin": "https://CALLS",
  "projectId": "PROJECT",
  "projectKey": "SECRET",
  "mediaOrigin": "https://CLAWDTIME_MEDIA",
  "mediaKey": "FRESH_MEDIA_KEY",
  "encryptionKey": "FRESH_64_HEX_CHARACTERS",
  "testerAllowlist": ["PRIVATE_E164"],
  "testers": [
    {
      "memberId": "tester_id",
      "recipient": "PRIVATE_E164",
      "deviceId": "new_device_id",
      "displayId": "OBSERVED_NUMERIC_DISPLAY_ID"
    }
  ],
  "handoff": {
    "owner": "clawdtime",
    "sourceOwnerPaused": true,
    "lineId": "LOGICAL_UUID",
    "providerLineId": "NATIVE_ID",
    "instanceId": "NATIVE_INSTANCE",
    "baseline": { "sequence": 1, "eventId": "VERIFIED_RETAINED_EVENT" },
    "checkedAt": 0,
    "rollbackRecord": "PRIVATE_RECORD_REFERENCE"
  }
}
```

The values above are not usable defaults. `enabled:true` attests configured native
access; environment mode controls dispatch. Keep the config intact when switching
to standby: the runtime uses it to end/reconcile already-owned calls without
creating new effects. Simulation refuses to open a database containing unclosed
live media records without the correct cleanup configuration.

After LINE_HANDOFF.md prerequisites: set `CLAWDTIME_MODE=live` and
`CLAWDTIME_LIVE_TRAFFIC=true`. Those flags alone cannot supply the exact identity,
retained anchor, tester allowlist or source pause evidence. `mediaKey` must match
backend `CLAWDTIME_MEDIA_TOKEN` and media `MEDIA_API_KEY`.

## Media, gateway and Mac

Deploy `media/Dockerfile` separately with its own persistent database volume and
fresh credentials from `media/.env.example`. Configure `BACKEND_URL` to ClawdTime,
not Apple Teams. Media health without provider credentials is not call readiness.
Follow `docs/MEDIA_INTEGRATION.md`, `docs/DEVICE.md` and component READMEs.

The Mac gateway makes outbound authenticated WSS to the new media service. The
companion stays on loopback. Tailscale is optional. No cloud tailnet enrollment or
public companion endpoint is required. Configure fresh helper/gateway keys with
the private setup generator; provision only that gateway key on new media.

Optional AI actions require `CLAWDTIME_AI_ACTIONS=true`, explicit provider/model,
and an independent provider key. They are default off. Provider/model access was
not exercised against a real screen in this session. No speech, frame or typed
content belongs in deployment logs.

## Backup and recovery

Backend uses SQLite FULL synchronous transactions and owner-only storage.
`npm run backup -- create SOURCE.sqlite NEW_BACKUP.enc` performs VACUUM INTO and
AES-256-GCM encryption using the independent `CLAWDTIME_BACKUP_KEY` (64 hex
characters, loaded from the operator secret store).
`npm run backup -- restore BACKUP.enc NEW_OFFLINE.sqlite` authenticates the envelope,
checks SQLite integrity and refuses an existing destination. A synthetic encrypted
backup/restore test preserves unknown receipts. Store backups offsite separately
from the key.
Do not copy a live SQLite file without its committed WAL. Do not restore over an
active database. Before enabling a restored database, reconcile native effects
since the snapshot, event anchors, call rooms and helper receipts. Restoring an
old cursor can duplicate effects even if the database passes integrity checks.

Media has an authenticated encrypted ledger snapshot route and retained unit
coverage. Gateway/helper receipts and tombstones have independent recovery paths.
An end-call effect attempts native hangup even if media close fails; readiness
must still show both native and media cleanup. Unknown action/text/call outcomes
remain retained. Recovery never changes an old action ID to force a retry.

No automated production backup bucket or hosted restore drill was provisioned;
operators must configure protected offsite storage before external deployment.

For local configuration, export variables through your secret manager or use
`node --env-file=.env dist/src/server.js` after building; `npm run dev` does not
implicitly load a dotenv file. Never use an Apple Teams environment file.
