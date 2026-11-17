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

## Prepared live presentation staging

`CLAWDTIME_LIVE_PRESENTATION_ENABLED` defaults to false independently in backend and
media. A new original-chat connector must explicitly register
`--screen-camera true --camera-display ID --live-presentation true` using
its normal exact surface arguments. Consult connector help for the complete command;
existing sessions cannot upgrade their capability. The backend requires the
versioned helper capability from scoped readiness, current view lease, no input
owner, and exact conversation cursor. These presentation endpoints remain camera-only;
the separately negotiated activation path below owns its own reservations.

Release matching backend, media, gateway and companion artifacts. Keep new admission
off until the selected display, lease-bound resolver, original timestamps and remote
latency budgets are qualified. Existing sessions and snapshot capture continue on
their prior path. Do not promote the experimental persistent preview stream as a
capture repair. No call may be placed without the user's separate authorization.

Backend receipts live in the existing durable entities store; media adds a
`presentation_receipts` table with session-namespaced command IDs. Old binaries can
ignore this table during rollback; never delete it or restore an older database to
replay a command. Record current service deployments and preserve the configuration,
active cursor and all unknown outcomes before changing running components.

## Narrow native activation staging

`CLAWDTIME_NATIVE_ACTIVATION_ENABLED` defaults off independently in backend and
media. New original-chat v2 sessions explicitly select `--native-activation true`
alongside the display camera, live presentation and verified desktop native-control
capabilities. Existing registrations cannot acquire it by reconnecting.

Preparation reserves the exact operation and device in the backend before any
remote qualification. Its planning expiry is at most the original lease expiry
and twenty seconds. A fixed CUA trigger initiates dispatch once, creating a
separate immutable deadline of at most two seconds. Every helper setter and
settling observation requires the installed parent's current local policy;
Stop kills the disposable AX child without waiting for the cloud or AX.
An exact returned receipt proves the host finished, not that its target UI is
correct. Only fresh independent foreground/focus/on-screen evidence verifies UI.

Backend, media, gateway and helper retain native reservations. Prepared operations
can expire without input; dispatching/submitted/uncertain operations never expire
into permission to retry. They fence the entire Mac, including replacement chats
and other displays. Read original receipts to reconcile; never replace IDs,
delete ledgers, restore older databases or replay effects.

For an isolated no-call rehearsal, use a private synthetic helper configuration
with a fresh device ID beginning `synthetic_`, a separate loopback port and one
explicit display/controller. Launch the candidate companion with that config and
Enable that candidate locally through native CUA. Keep the installed production
helper disarmed. Run:

```sh
npx tsx scripts/production-walkthrough.ts PRIVATE_HELPER_JSON PRIVATE_SCENE_PLAN
```

This script uses simulation transport only and the production backend routes,
media controllers, gateway and installed-helper native host. It writes a private
local-access file and retains all test receipts. Its JSONL `prepare` command does
not dispatch; click the fixed prepared-operation button using the original chat's
native CUA. `claim`/`release` bracket original-chat fixture edits and moves. Local
helper Stop is authoritative; end with the harness `stop` command and inspect
process cleanup and unresolved counts separately. The harness is excluded from
the media image and has no deployed bypass route.

Release only after local acceptance and independent review. Freeze the committed
source in an isolated upload directory; replace each packaged `release-source.json`
with that exact SHA. Backend and media health expose the baked revision; gateway
version metadata exposes its revision and runtime digest. Companion Info.plist
records the source revision and whether implementation files were dirty. Verify
actual running versions and artifact hashes after rollout, not merely upload or
Git status. Keep both admission gates off and the installed companion disarmed.

A compatible rollback retains all ledgers and starts disarmed with admission off.
Never roll back to a pre-activation binary while a native reservation is unresolved:
older binaries do not enforce this new fence. Stop, join and reconcile first, or
retain the compatible disabled release. Do not restore a stale cursor or volume.
