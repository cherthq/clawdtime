# Independent deployment and operations

ClawdTime has an independent Railway project, backend and media services, domains,
and dedicated persistent volumes containing retained production state. It uses
existing account capacity. Never treat those volumes as empty or restore an old
cursor to retry a call. Source is maintained in `cherthq/clawdtime`.

- Project: `9fafdcf9-c7eb-4465-8387-ec3f8acbaefa`.
- Backend/landing: https://backend-production-ee686906.up.railway.app
- Media: https://media-production-33fda109.up.railway.app
- Services: backend `b4af7a8c-c6b1-4b1c-af2f-dbaedad618ea`,
  media `07eabf9a-c8fd-46da-8210-54c7d2f868fb`.
- Environment: `8f5a3eb3-37e1-480a-ad07-6e89968a1b8c`.

Check STATUS.md for current ownership and physical qualification. Deployment health
alone is not demo readiness. No Apple Teams source or sibling service was replaced.

## Backend

Node 24+, `npm ci && npm run build`, then `npm start`. The root Dockerfile provides
a separate Node service that drops to UID/GID 1000 before application startup.
Railway needs `RAILWAY_RUN_UID=0` so the small entrypoint can assign its root-owned
volume to UID 1000; actual deployed DB ownership was verified as UID 1000. For
local Docker use a volume owned by UID 1000 or `--user 0` for the same bootstrap.
Mount an empty dedicated persistent `/data`
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
For managed hosting, `CLAWDTIME_LIVE_CONFIG_JSON` may instead carry the same object
through the host secret store. Set exactly one source. Null/scalar/array roots and
malformed JSON are rejected without logging their contents.
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
    "phone": "PRIVATE_LINE_E164",
    "identityEvidence": "PRIVATE_VERIFIED_BINDING_RECORD",
    "sourcePauseEvidence": "PRIVATE_SOURCE_PAUSE_RECORD",
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
