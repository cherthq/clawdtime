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
