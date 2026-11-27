# Shared number setup

The shared service routes a verified caller to their own paired Mac. It has
one call slot. Calls and completion callbacks wait for that slot. An unknown
provider outcome keeps the slot reserved instead of dialing again.

## Status

Shared calls are not qualified. The code for signed incoming calls, outgoing
completion callbacks, result walkthroughs and computer actions during the same
call is in this repository. It has passed automated tests only.

- `clawdtime shared` says that shared calls remain unavailable until the
  provider, media and callback integrations are qualified.
- `clawdtime shared doctor` reports live shared-call acceptance as not
  qualified.
- The coordinator's `/health` reports `physicalAcceptance: false`.
- No physical call test with real phones and Macs has run.

Do not publish a shared number to real users while this status holds. A
health response with mode `enabled` is not readiness.

The code now includes call codes bound to the paired Mac, sign-in limits,
call liveness, the release of unverified callers, re-pair, credential rotation
and revoke. These parts have passed automated tests only.

## Coordinator

Use Node 24 or later, one persistent host and a private disk. Run `npm ci`,
`npm --prefix line ci`, then `npm run check`. `line/package-lock.json` pins
the voice library versions. Run one coordinator process, not multiple SQLite
replicas. Keep the host awake and connected to the internet.

Create an owner-only JSON file in an owner-only directory. Set
`CLAWDTIME_SHARED_CONFIG` to its absolute path. Keep it outside the checkout.

| Field                             | Value                                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                         | `false` for standby, `true` after provider configuration and handoff                                                          |
| `database`                        | Absolute private SQLite file path                                                                                             |
| `lineId`                          | Exact provider line UUID                                                                                                      |
| `invited`                         | Phone numbers, with country code, that may get a sign-in text before they are members. Others get the same answer and no text |
| `proofKey`                        | 32 random bytes encoded as 64 hex characters                                                                                  |
| `identityKey`                     | A different persistent 32-byte hex key                                                                                        |
| `lineToken`                       | A separate random server credential, at least 32 characters                                                                   |
| `host`                            | `127.0.0.1` (the default). See [Operations](#operations)                                                                      |
| `behindProxy`                     | `true` only when a proxy or tunnel on this host appends the client address to `X-Forwarded-For`. Default `false`              |
| `port`                            | Local port, default 3318                                                                                                      |
| `messaging.origin`                | Exact HTTPS provider API origin                                                                                               |
| `messaging.projectId`             | Exact project UUID                                                                                                            |
| `messaging.key`                   | Private project API key, at least 32 characters                                                                               |
| `provider.integrationId`          | Exact signed webhook integration UUID                                                                                         |
| `provider.endpoint`               | Public HTTPS origin followed by `/provider/webhook`                                                                           |
| `provider.webhookSecret`          | The integration's signing secret, at least 32 characters                                                                      |
| `provider.controlCredentialsFile` | Absolute protected Chert CLI credential file path                                                                             |
| `provider.media.url`              | WSS URL for the LiveKit project                                                                                               |
| `provider.media.key`              | Private LiveKit API key                                                                                                       |
| `provider.media.secret`           | Private LiveKit API secret                                                                                                    |
| `provider.media.agentName`        | Unique named shared voice worker                                                                                              |

The coordinator checks the file at startup. It refuses to start when a field
is missing, unknown or malformed, for example a `lineId` or
`messaging.projectId` that is not a UUID.

The entire `provider` object may be omitted in initial standby. Enabled mode
requires it. Start the compiled entry point:

```sh
node dist/scripts/shared-number-server.js
```

Health shows the mode and whether the provider is configured, not secrets.
All other routes return 503 in standby. Back up the database and persistent
keys together. Changing the identity key changes account subjects. A second
process refuses the database's `.owner` lock. After an unclean exit,
reconcile pending provider and media effects before you remove a stale lock.
Its `owner.json` identifies the process that created it. Never remove a live
process's lock.

## Operations

**Bind and TLS.**

- Keep `host` at `127.0.0.1`. Put TLS in front of it on the same host: a
  tunnel, or a reverse proxy with its own certificate. Never expose the
  coordinator port directly.
- Use `0.0.0.0` only when a restricted HTTPS proxy is the only way to reach
  the port.
- The tunnel or proxy must allow ten-second device polls and 125-second chat
  responses.
- Sign-in limits count each client by its address. With `behindProxy` at
  `false`, the coordinator ignores `X-Forwarded-For` and uses the socket
  address. Behind a tunnel or proxy on the same host, that address is the
  proxy's, so every person shares one allowance.
- Set `behindProxy` to `true` when the coordinator listens on `127.0.0.1`
  behind a tunnel or reverse proxy that appends the client address to
  `X-Forwarded-For`. The coordinator then uses the last entry of that header,
  and only on a request from a loopback or private address. A client cannot
  choose that entry, because the proxy adds it after any value the client
  sent. Never set it when clients can reach the port directly.
- One number gets at most 15 sign-in texts an hour. Clients that never signed
  in to that number share 5 of them. A client that signed in to it before has
  its own 10, so other clients cannot lock the member out on that client.
- Turn off request and response body logging in the proxy.
- Do not expose the local desktop API. Participant Macs connect outward.

**Request inspection.** An inspector keeps whole requests and responses. On
this coordinator they hold sign-in codes, session tokens, device credentials,
call codes and screen frames. Keep every inspector off.

- With the ngrok command line, start the tunnel with inspection off:

  ```sh
  ngrok http 127.0.0.1:3318 --inspect=false
  ```

- In an ngrok agent configuration file (version 3), set
  `inspect_db_size: -1` under `agent`. This turns off inspection for every
  endpoint of that agent.
- Keep Full Capture mode off in the ngrok account's Traffic Inspector
  settings.
- For any other tunnel or proxy, find its request inspection or capture
  feature and turn it off before the first request.

**Secrets.**

- Keep the webhook secret only in the coordinator's private environment: its
  owner-only configuration file on the host. The coordinator reads it from
  there. Never put it in the checkout, a tunnel configuration, shell history,
  a log, a ticket or a chat.
- Rotate the webhook secret after any exposure, for example an inspector that
  was on, a log that held it or a copy off the host. Get a new signing secret
  for the integration from the provider, write it to
  `provider.webhookSecret`, then restart the coordinator. The coordinator then
  refuses events signed with the old secret (403).
- Rotate `lineToken`, `messaging.key` and `provider.media.secret` the same way
  after an exposure. A new `lineToken` also goes to the voice worker.
- A Mac replaces its own device credential with `shared rotate`. If a device
  credential may be stolen, pair the Mac again with `shared pair ORIGIN
--replace`. That revokes the old pairing and every credential of it. See
  [Replace, rotate and revoke](#replace-rotate-and-revoke).
- If a sign-in code, session token or device credential may be exposed, set
  `enabled` to `false` and restart. Standby refuses every route except health.

## Provider and voice worker

In the provider dashboard, select the exact project and line. Configure an
HTTPS integration with webhook signing enabled. Save its one-time secret
privately. Select `customer_decides` and no default Assistant. Verify the
integration ID, endpoint and signing flag through the provider read API.
See [incoming room setup](https://docs.trychert.com/facetime/bring-your-own-room)
and [signed webhooks](https://docs.trychert.com/facetime/webhooks).

Release any existing connector at an idle boundary using its retained-owner
handoff. Preserve its journals and recovery configuration. Do not run two
line owners. The webhook route remains assigned while outbound callbacks use
the [Calls API](https://docs.trychert.com/facetime/outbound). It does not require
the optional custom BYOR CLI pilot or a per-callback connector handoff.

Run `node line/shared-agent.mjs start` with a private environment containing:

- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `OPENAI_API_KEY`.
- `AGENT_NAME`, matching `provider.media.agentName`.
- `CLAWDTIME_SHARED_ORIGIN`, the public HTTPS coordinator origin.
- `CLAWDTIME_SHARED_LINE_TOKEN`, matching `lineToken`.
- Optional `CLAWDTIME_SHARED_WORKER_PORT`, default 3320, for local health.

The coordinator passes the webhook's `data.from` to the router as the
caller. The provider must send it in the same form that the member verified
at sign-in, for example `+14155550100`. The router keeps only a keyed digest
of it. The caller handle never authorizes a Mac. It only selects whose paired
Mac may be shown the call code.

The coordinator declines a call at once when no Mac could ever be shown its
code: the call has no caller handle, or the handle is not the verified number
of a member with a paired Mac. Such a call gets no room and does not hold the
slot. One caller handle may hold the slot without verifying five times an
hour. The coordinator declines its further calls in that hour, so someone who
sends a member's number cannot keep the line busy.

A caller who does not verify within 90 seconds is released. The voice worker
removes the call's room, and the coordinator removes it on its next pass as
well. Removing the room ends the provider call. The line slot frees only after
the provider reports the call ended and cleaned up and the room is gone. The
same applies to a call whose code attempts ran out or whose Mac was offline.

Only central processes receive provider, voice and line credentials. Mac
participants receive their own device credential. Keep the provider control
login valid. An expired credential blocks new callbacks. The service rereads
that protected file rather than caching a stale token.

Before enabling the coordinator, confirm the exact line is idle, media
readiness is fresh, the signed integration is assigned, and no connector is
active or connected. The runtime repeats these checks before every callback.
Provider recipient policy, billing, trial expiry and usage limits still apply.
Dedicated lines use their configured recipient policy. ClawdTime sign-in does
not override provider restrictions.

## Participant Mac

Install ClawdTime on macOS 14 or later with Node 24+, Xcode command line
tools, model credentials and the native permissions in [INSTALL.md](../INSTALL.md).
Start the desktop service and enable computer use. Skip dedicated `connect`
line-claim steps for a shared participant. Do not give a participant provider
keys or the central line token.

Build the source and native helpers, then use this checkout's compiled command:

```sh
node dist/cli/index.js shared pair https://coordinator.example
node dist/cli/index.js shared run
```

Replace the example origin with the coordinator's public HTTPS origin.
Pairing asks, in order, for:

1. Your own phone number, and consent to send a sign-in text to it.
2. The sign-in code from that text.
3. The display ID to pair.
4. The absolute path to `ClawdTimeTaskCapture`, or Enter to turn sharing off.
   With a path, it asks whether this exact display may be shown during your
   verified calls. This is your view answer.
5. Whether ClawdTime may open an inert task result report during your
   verified callbacks.
6. Whether this account may request computer actions on this Mac. Pairing
   asks this only when you allowed view. Computer actions need view.
7. A final yes to pair.

Pairing sends your real view and control answers to the coordinator. This Mac
also keeps both answers in its `connection.json` and enforces them itself,
whatever the coordinator sends. It refuses chat and every other computer
request that you declined. Stop, close and hide always run.

View is the base permission of a shared call. With view declined, a call
cannot open, renew, show or report anything on this Mac, and computer actions
stay off. `shared doctor` and `shared run` show both answers.

A `connection.json` from an earlier release has no saved answers, so this Mac
allows nothing. Pair it again with `shared pair ORIGIN --replace` to record
your answers.

Use `mac/.build/debug/ClawdTimeTaskCapture --list-displays` to list displays.
The capture binary needs Screen Recording permission. The panel needs its
Accessibility and Screen Recording permissions.

One Mac per account. `shared pair` refuses to run when this Mac is already
paired, and the coordinator refuses a second Mac for the same account unless
you ask to replace it. See [Replace, rotate and revoke](#replace-rotate-and-revoke).

Keep `shared run` open. Ctrl+C disconnects the Mac and closes its call and
capture process. A desktop restart needs a fresh connection. Uncertain actions
are not replayed. `shared doctor` checks the local configuration and desktop.

Call the shared number from your verified phone. The voice agent asks you to
run `shared prove` on your paired Mac. Keep `shared run` open, and in another
terminal on that Mac, run:

```sh
node dist/cli/index.js shared prove
```

Confirm that you are on the call. The command shows an eight-digit call code.
Say it on the call. It sends no sign-in text.

- Only your paired Mac gets the code. It asks with its own device credential,
  over its live `shared run` connection. A sign-in alone never gets a code.
- The coordinator gives the code only when the waiting call comes from your
  verified number. Another member's Mac gets no code for your call, so no one
  can take or block it.
- The code admits the call only to the connection that showed it. It works
  once and expires within two minutes, and never after the 90-second window.
- When `shared prove` says that no code was given, check that `shared run` is
  open and that you called from your verified number, then run it again.

## Replace, rotate and revoke

**Replace a lost Mac.** On the new Mac, run:

```sh
node dist/cli/index.js shared pair https://coordinator.example --replace
```

Sign in with your phone and accept the pairing on the new Mac. Accepting it
revokes the old pairing and all of its device credentials. The old Mac can no
longer connect. Its open call ends, and its tasks get no callback. Without
`--replace`, the coordinator refuses a second Mac for your number.

**Rotate a device credential.** On the paired Mac, run:

```sh
node dist/cli/index.js shared rotate
```

The Mac gets a new credential and the old one stops working at once. Start
`shared run` again. If the answer is lost, pair the Mac again with
`--replace`. If a credential may be stolen, use `--replace`, not `rotate`:
the person with the stolen credential could rotate it first, but cannot sign
in with your phone.

**Revoke.** `POST /account/revoke` with a session token unpairs your Mac and
revokes its credentials. Your number stays a member and can pair again. One
sign-in code alone never bans a number. To ban your number for good, send
`{"permanent": true, "deviceCredential": "..."}` with the current credential
of your paired Mac. The coordinator then refuses that number from then on.

## Demo and callback

First say:

> Open a new browser tab and search for blue whales. Then show my screen.

Ask for another click or navigation in the same call. Confirm the action on
your Mac and the picture on your phone. A tool acknowledgement alone is not
visual proof.

For a callback, start a coding task, then say this as a separate turn:

> Call me when it finishes.

End the original call and leave the Mac connected. Completion uses the exact
job's successful exit and result receipts. The callback waits for the line to
be free. On answering, verify the new call with `shared prove`. It narrates
the original result and, if locally allowed, opens an inert report on your
Mac and requests screen sharing. The report is not a claim that the generated
artifact works. Ask to open that artifact or perform further computer actions
in the same call. A different task or replacement Mac is never substituted.

A callback that fails before its dial sent nothing: the Mac left, a
readiness read failed or the room was not ready in time. The coordinator
removes its room, frees the slot and tries the callback again after 30
seconds, then after a pause that doubles each time. After five such tries it
cancels the callback.

Missed calls and unknown dials are not automatically retried. A dial that may
have gone out keeps the slot. When the provider returned its call ID, the
coordinator reads that call again and frees the slot only after it is terminal,
cleaned up and its room is gone. A dial with no call ID cannot be read: preserve
the private receipts and reconcile the exact recorded call before freeing the
slot.

## Verification and rollback

The shared tests run two simulated Macs over loopback HTTP with signed
provider events and fake provider effects. They cover replay and identity
rejection, answer gating, callback cleanup, exact result ownership, report
escaping, expired leases and same-call actions. One end-to-end test sends a
signed incoming call from a member's number. That member's Mac gets the code
and the call opens only on it, another member's Mac gets no code, a stranger
is declined at once, and a member's call that nobody proves is released after
90 seconds and its room removed. They send no real texts,
place no calls and capture no screens. They do not prove handset audio,
picture or native input.

To roll back, disable new shared admissions, wait for observed provider and
media cleanup, stop the shared voice worker, then restore the retained prior
owner at an idle boundary. Keep all journals. Never change a callback recipient
or erase an uncertain effect to make recovery look successful.

Shared inbound texting and email identities are not implemented. The existing
dedicated masked-number text poller must not route shared users.
