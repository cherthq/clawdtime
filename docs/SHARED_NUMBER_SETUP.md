# Shared number setup

The shared service routes a verified caller to their own paired Mac. It has
one call slot. Calls and completion callbacks wait for that slot; an unknown
provider outcome keeps it reserved instead of dialing again.

This release implements signed incoming calls, outgoing completion callbacks,
exact-result walkthroughs and computer actions during the same call. The
coordinator must report enabled and its provider route must be configured
before publishing a shared number. A standby health response is not readiness.

## Coordinator

Use Node 24 or later, one persistent host, private disk and HTTPS termination.
Run `npm ci`, `npm --prefix line ci`, then `npm run check`. The line lock pins
LiveKit Agents 1.8.0 and Server SDK 2.20.1. Run one coordinator process, not
multiple SQLite replicas. Keep the host awake and connected to the internet.

The HTTPS proxy must allow ten-second device polls and 125-second chat
responses. Disable request and response body logging and tunnel inspection.
Do not expose the local desktop API. Participant Macs connect outward.

Create an owner-only JSON file in an owner-only directory. Set
`CLAWDTIME_SHARED_CONFIG` to its absolute path. Keep it outside the checkout.

| Field                             | Value                                                                |
| --------------------------------- | -------------------------------------------------------------------- |
| `enabled`                         | `false` for standby, `true` after provider configuration and handoff |
| `database`                        | Absolute private SQLite file path                                    |
| `lineId`                          | Exact provider line UUID                                             |
| `proofKey`                        | 32 random bytes encoded as 64 hex characters                         |
| `identityKey`                     | A different persistent 32-byte hex key                               |
| `lineToken`                       | A separate random server credential, at least 32 characters          |
| `host`                            | `127.0.0.1`, or `0.0.0.0` behind a restricted HTTPS proxy            |
| `port`                            | Local port, default 3318                                             |
| `messaging.origin`                | Exact HTTPS provider API origin                                      |
| `messaging.projectId`             | Exact project UUID                                                   |
| `messaging.key`                   | Private project API key                                              |
| `provider.integrationId`          | Exact signed webhook integration UUID                                |
| `provider.endpoint`               | Public HTTPS origin followed by `/provider/webhook`                  |
| `provider.webhookSecret`          | The integration's one-time signing secret                            |
| `provider.controlCredentialsFile` | Absolute protected Chert CLI credential file path                    |
| `provider.media.url`              | WSS URL for the LiveKit project                                      |
| `provider.media.key`              | Private LiveKit API key                                              |
| `provider.media.secret`           | Private LiveKit API secret                                           |
| `provider.media.agentName`        | Unique named shared voice worker                                     |

The entire `provider` object may be omitted in initial standby. Enabled mode
requires it. Start the compiled entry point:

```sh
node dist/scripts/shared-number-server.js
```

Health exposes mode and provider configuration, not secrets. All other routes
return 503 in standby. Back up the database and persistent keys together.
Changing the identity key changes account subjects. A second process refuses
the database's `.owner` lock. After an unclean exit, reconcile pending provider
and media effects before removing a stale lock. Its `owner.json` identifies
the process that created it. Never remove a live process's lock.

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

Only central processes receive provider, voice and line credentials. Mac
participants receive their own device credential. Keep the provider control
login valid; an expired credential blocks new callbacks. The service rereads
that protected file rather than caching a stale token.

Before enabling the coordinator, confirm the exact line is idle, media
readiness is fresh, the signed integration is assigned, and no connector is
active or connected. The runtime repeats these checks before every callback.
Provider recipient policy, billing, trial expiry and usage limits still apply.
Dedicated lines use their configured recipient policy. ClawdTime sign-in does
not override provider restrictions.

## Participant Mac

Install the selected release on macOS 14 or later with Node 24+, Xcode command
line tools, model credentials and the native permissions in [INSTALL.md](../INSTALL.md).
Start the desktop service and enable computer use. Skip dedicated `connect`
line-claim steps for a shared participant. Do not give a participant provider
keys or the central line token.

Build the source and native helpers, then use this checkout's compiled command:

```sh
node dist/cli/index.js shared pair https://coordinator.example
node dist/cli/index.js shared run
```

Replace the example origin with the enabled coordinator. Pairing asks for
your phone, consent to a sign-in text, the sign-in code, display selection,
view/control permission and permission to open inert task-result reports.
Use `mac/.build/debug/ClawdTimeTaskCapture --list-displays` to list displays.
The capture binary needs Screen Recording permission. The panel needs its
Accessibility and Screen Recording permissions.

Keep `shared run` open. Ctrl+C disconnects the Mac and closes its call and
capture process. A desktop restart needs a fresh connection. Uncertain actions
are not replayed. `shared doctor` checks the local configuration and desktop.

Call the shared number. In another terminal, run:

```sh
node dist/cli/index.js shared prove
```

Sign in, confirm that you are on the call, then say the separate eight-digit
call code. It expires within two minutes. Never speak the sign-in code to the
voice agent. Only the verified account's current paired Mac can be selected.

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

Missed calls and unknown dials are not automatically retried. If provider
cleanup, room removal or route restoration is uncertain, preserve the private
receipts and reconcile the exact recorded call before freeing the slot.

## Verification and rollback

Validation on 2026-11-26: `npm run check` passed typecheck, **10,970 tests
across 278 files**, and build. The independent line suite passed 325 tests;
the two added media tests also passed under Node’s test runner. Shared tests
exercise two simulated Macs over HTTP, signed provider events, replay and
identity rejection, answer gating, callback cleanup, exact result ownership,
report escaping, expired leases and same-call actions. They use no real calls,
texts or screen capture. A two-person physical test is not required for this
release; actual handset and native-permission behavior remains unverified by
these automated tests.

To roll back, disable new shared admissions, wait for observed provider and
media cleanup, stop the shared voice worker, then restore the retained prior
owner at an idle boundary. Keep all journals. Never change a callback recipient
or erase an uncertain effect to make recovery look successful.

Shared inbound texting and email identities are not implemented. The existing
dedicated masked-number text poller must not route shared users.
