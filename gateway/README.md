# ClawdTime companion gateway

The preferred deployment runs this gateway on the enrolled Mac. It makes an
**outbound authenticated WebSocket** to the ClawdTime media service; the helper
stays on loopback. Railway needs no Tailscale route, public helper port, Funnel,
new Tailscale identity, or private networking credential.

This code is gated and is not proof of Screen Recording / Accessibility approval
or physical FaceTime screen delivery. Viewing must pass before testing control.

## Mac deployment

Use an isolated Python 3.12 virtual environment in
`~/Library/Application Support/ClawdTimeGateway`; do not install into Chert's
runtime. Install `requirements.txt` into that environment. Copy `service.py` and
`relay.py`, then start `python relay.py` under an owner-controlled LaunchAgent.
Environment:

- `DEVICE_GATEWAY_KEY`: fresh 32+ character gateway-only secret. Set the same key
  on ClawdTime media; it does not grant the gateway access to other media APIs.
- `DEVICE_GATEWAY_RELAY_URL`: `wss://MEDIA-HOST/device-gateway`.
- `DEVICE_GATEWAY_DEVICES_FILE`: owner-only JSON mapping of exact registered IDs
  to helper origins and fresh helper-only bearer keys. Example shape:
  `{"device_m4a":{"url":"http://127.0.0.1:4213","key":"REPLACE_WITH_FRESH_HELPER_SECRET"}}`.
- `DEVICE_GATEWAY_DATABASE_PATH`: owner-only path for durable lease tombstones and
  action receipts. Preserve this database across restarts.

Media requires `DEVICE_GATEWAY_RELAY=true`, the matching key, and
`MEDIA_DEVICES_ENABLED=true` only after enrollment/readiness checks. The backend
has its own independent authorization/configuration gate. A relay connection by
itself does not authorize a screen or input. The helper defaults locally disarmed;
its owner must grant permissions and arm sharing separately.

The gateway also supports direct HTTP mode with `python service.py`, defaulting
to loopback port 4214. For remote deployment, place it behind authenticated TLS
and provide private Tailscale reachability to each helper. An ordinary Railway
container does not acquire a tailnet route automatically. Never expose the helper
itself publicly. Fixed helper origins allow HTTPS, loopback HTTP, or Tailscale
100.64.0.0/10 HTTP only; user commands cannot supply URLs.

## Safety and recovery

- At most eight in-flight relay requests; no reconnect replay. Bodies are bounded
  to 2 MiB; only the lease/frame/action API is proxied. No arbitrary URLs/shell.
- Device/call/member/display/mode-bound leases expire within 30 seconds. The
  backend grants 20-second rolling leases; media clears stale pixels within two
  seconds and releases capture on stop, switch, revocation, or call cleanup.
- One stable FaceTime video track switches between captions and the selected
  screen. Device helpers never join the LiveKit call room.
- Local Stop, denied/expired leases, failed creation, and service restarts leave
  tombstones. They require a new explicit selection and lease ID.
- A source/mode switch cancels the preceding poll and awaits confirmed helper
  release before creating the replacement lease. DELETE returns `released:true`
  only when release is confirmed; unknown creation remains `creating_unknown`
  across gateway restart until its lease expires. Uncertain release prevents a
  replacement until the maximum expiry sent (including in-flight renewals), and
  requires a new explicit selection. This repair requires copying `service.py`
  and restarting the gateway; it does not require a helper binary/TCC change.
- Frames and input text are never persisted by the gateway. Persisted records
  contain bindings, hashes, timestamps and receipts. Logs never print pixels,
  input text, tokens, or full request bodies.
- A control receipt marked `submitted` means the OS accepted an input event; it
  does not verify what the application did. Unknown results are reconciled by GET
  against the same action ID and never automatically reissued.

## Checks

From the repository root with media test dependencies installed:
`media/.venv/bin/python -m unittest discover -s gateway -p 'test_*.py'`.
Run the media suite separately. Fake helper tests do not capture a Mac screen or
send an input event. Physical acceptance requires an enrolled authorized Mac,
local permissions/indicator/Stop, a consenting FaceTime recipient, and explicit
verification of view, switching, stop, then control.

## Protected local startup and readiness

The ClawdTime setup generator now emits private `gateway.json`. Prefer
`media/.venv/bin/python gateway/start.py --config /absolute/private/setup/gateway.json`
for the local relay. `--check-config` validates without creating a ledger or making
a network request. The wrapper locks `gateway-process.lock` before opening SQLite
and refuses duplicate wrappers; do not start a direct `relay.py` process alongside
it. `mac/scripts/prepare_launchagent.py` creates only `com.clawdtime.gateway` with
paths, no embedded credentials, and prints lead-owned launch/stop commands.

Authenticated `GET /v1/devices/:device/readiness/:member/:display` reads the fixed
helper's `/v1/status`, `/v1/displays`, `/v1/permissions` only, verifies exact device
identity and returns scoped ACL booleans/permission flags. No arbitrary helper
origin, permission mutation or frame API is permitted by this route. The outbound
relay permits GET only for these bounded readiness paths.

### TLS and reconnect diagnosis

The outbound WSS client uses `ssl.create_default_context(cafile=certifi.where())`
with pinned `certifi==2026.10.23` and aiohttp's verified `TCPConnector`. This handles
framework Python installations whose default CA file is absent. Hostname checking
and `CERT_REQUIRED` remain enabled. This follows the
[aiohttp SSL configuration guidance](https://docs.aiohttp.org/en/stable/client_advanced.html#ssl-control-for-tcp-sockets)
and [Certifi's CA bundle API](https://pypi.org/project/certifi/).

Install the independent gateway environment with `python -m pip install -r
gateway/requirements.txt`. For combined media/gateway tests, install both component
requirements into the test environment. Do not edit global Python trust settings,
reuse another application's virtualenv, or turn TLS verification off.

A failed reconnect emits at most one warning every 30 seconds:
`gateway_reconnect_failed exception=TYPE http_status=STATUS suppressed=COUNT at=UTC_TIMESTAMP`.
Only a validated class name, numeric HTTP status (or `none`), count and UTC timestamp are logged.
URLs, credentials, response bodies, exception messages and tracebacks are excluded.
HTTP 401 indicates authentication rejection; 409 indicates an existing gateway
socket; TLS exception classes indicate trust/hostname verification failure.
A healthy gateway is confirmed through the independent media health/readiness
endpoints. No input request, lease or action is replayed during reconnect.

The gateway also retains a bounded `relay_diagnostics` table in its existing
SQLite file. The last 128 lease/frame/action hop events correlate media timeouts
with generated relay request IDs, fixed stages, UTC timestamps, durations and
statuses. Readiness polling is excluded; no payloads, paths, screen pixels or input
text are recorded. Preserve the receipt tables when updating or inspecting it.
A response-submitted stage is not proof of media receipt. Copy
`relay_diagnostics.py` together with `service.py` and `relay.py` for a gateway
source update; only the coordinating lead restarts the existing process after
known call/lease cleanup. No companion replacement or permission reset is needed.

## Versioned execution and local panel

Protocol-2 leases forward exact session/executor epoch/local-policy revision fields.
A higher-epoch renewal changes executor within the same sharing lease; identity,
display and session cannot change. The gateway commits the proposed authority before
forwarding the helper effect. A lost acknowledgement leaves `creating_unknown`
with the proposed binding and expiry, preventing dispatch by the old owner or blind
handoff replay. Pending/unknown input blocks handoff. Action requests must match the
current session, epoch and revision. Legacy shapes retain their old wire behavior.

Readiness passes through the helper's validated `controlPolicy`, `policyRevision`,
unresolved count and exact pending `panelCommand`. Controller ACLs remain separate
from fallback preference. Authenticated `POST /v1/devices/:device/panel` forwards
bounded transient status only to the registered helper's `/v1/panel`; WSS permits
POST only for this specific metadata route. It never forwards arbitrary URLs or
writes local preferences. Backend acknowledgements identify the same pending local
command; reconnect does not manufacture another mute/end/pause command.

Readiness also returns the validated exact `activeLeaseId` when the helper has an
active lease, alongside `activeLease`. Execution handoff checks that identity and
current local armed/available/permission status after helper acknowledgement;
a late acknowledgement cannot substitute another lease or override local Stop.
