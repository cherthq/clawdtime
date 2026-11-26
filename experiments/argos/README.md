# Argos + ClawdTime evaluation

This directory preserves the Argos code-camera and conversational FaceTime lab.
It is an isolated experiment, not yet integrated into ClawdTime's agent-session
execution or desktop-control path. The existing ClawdTime application is unchanged.

The camera shows a synthetic editor card with required/optional proposals.
ElevenLabs provides streaming conversation; LiveKit carries audio and video;
Chert places the explicitly requested FaceTime call. Camera tools focus the
prepared code card. No real desktop capture, code edits, or command execution are
enabled. The mock demonstration also exercises upstream training-failure detection,
deterministic triage, and repeated human decisions.

## Local setup

Requires macOS/Linux, Git, and Python 3.12. From this directory:

```sh
./bootstrap.sh
./run-mock.sh --seconds 900
```

The mock command needs no API keys and prints a local browser preview URL.
`bootstrap.sh` downloads a pinned public checkout into ignored `source/` and installs
the captured Python dependencies in `.venv/`. It does not fork or push upstream.
The original repository is kept separate, with its own attribution and terms.

Upstream: https://github.com/US3R070/HackUTA_Argos

Audited revision: `7ee7310da8c902f3770861b27bdaf0941b301589`.
The original local checkout was unmodified at capture. The lab wrappers, media
lifecycle, receipt guard, and tests in this directory are local additions.

## Explicit live configuration

Live commands require separate local configuration. Nothing is imported from
another project's hosting settings, secret store, or active installation.
Create `.private/` with mode 700 and each configuration file with mode 600.
Use the existing dedicated test agent when available; do not recreate it just
because a credential expires.

- `.private/media.env`: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
- `.private/elevenlabs.env`: `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`.
- `.private/cli/credentials.json`: current provider CLI login scoped to the exact
  project and calls origin. The existing CLI credential format is required:
  `kind`, `project_id`, `origin`, `expires_at` (milliseconds), `access_token`.
- `.private/line.json`: the following shape, populated privately with the intended
  line and an already verified, allowlisted test recipient:

```json
{
  "destination": "<verified recipient in E.164 format>",
  "testerAllowlist": ["<same verified recipient>"],
  "native": {
    "callsOrigin": "https://<calls service>",
    "projectId": "<project ID>",
    "projectKey": "<project credential>",
    "binding": {
      "lineId": "<logical line ID>",
      "phone": "<line number>",
      "workerId": "<worker ID>",
      "assignmentGeneration": 1
    }
  }
}
```

The provider must already have working messaging transport, a line verification
binding, and recipient verification from the recipient's actual phone. Adding a
number to this file does not verify it. Do not transfer ownership or replace
existing secrets as part of starting the harness. A current authorized project
member must obtain the scoped CLI login; temporary test access was removed after
the accepted call.

The dedicated ElevenLabs agent must expose only `show_code`, `show_full_screen`,
and `end_call`, require authentication, disable recording/retention, and limit
calls to 180 seconds. `create-agent.py` contains the exact creation payload and a
durable creation receipt; running it explicitly creates a provider resource.
Retain and reconcile any previous creation receipt before another attempt.

```sh
./run-media-test.sh  # Real cloud media smoke test; no phone dial
./run-live.sh        # Read-only exact-line/owner preflight; no phone dial
./run-live.sh --call # One explicitly authorized, bounded FaceTime attempt
```

The live guard verifies line identity, assignment acknowledgments, fresh worker
readiness, no existing integration/assistant, no competing connector, and no active
project calls. It checks again immediately before placing one call. The provider
enforces recipient verification. Ctrl-C/termination triggers bounded cleanup.
The answer timeout is 60 seconds and the answered call is limited to 180 seconds.

`.private/live-call-receipt.json` preserves placement and cleanup outcomes. An
existing receipt blocks a new attempt. Reconcile the provider call and confirm
terminal worker cleanup before archiving a receipt; never delete uncertainty to
force another call. The local lock complements provider checks, not a distributed
ownership lease. Do not run this alongside another live owner or a second lab copy.

## Isolated verification transport change

`patches/isolated-verification-transport.patch` preserves the narrowly scoped
control-plane reader, matching tests, and API documentation developed for the
test. It adds `CHERT_VERIFICATION_TRANSPORTS_ISOLATED` as a fallback only when a key
is absent from all established maps. Existing entries cannot be overridden by the
new map. Diagnostics contain bounded flags, not credentials or raw errors.

Patch baseline: `1aecfbe16b5d3ec9547adfcb125ea13a986bc5f7`;
captured implementation: `9bcb46a5` in the separate lab checkout. This is a source
artifact, not an automatic migration or deployment. It includes no installed
transport configuration, messages, customer records, or credentials. No rejected
call-transfer SQL proposal is included.

## Validation and remaining integration work

On November 16, 2026, the supervised live test on the selected line completed
recipient verification and a FaceTime call. The human confirmed audio and the code
camera worked. Worker-confirmed cleanup followed. Temporary project access and
its CLI credential were removed. Interruption quality was not separately confirmed;
a late audio callback warning during teardown remains a follow-up.

That physical result applies to the original configured lab. This portable copy
replaces machine/account-specific configuration discovery with explicit private
files; it does not carry over live authorization or credentials. Its default is
mock/read-only. Real ClawdTime workspace rendering, exact agent-session continuation,
and code execution remain integration work.

Local checks, without a live call:

```sh
.venv/bin/python -m pytest -q test_call_guard.py test_connector_preflight.py test_private_config.py
./run-mock.sh --smoke
```

Snapshot validation: 33 lab tests passed; the mock smoke check passed training
failure detection, triage, repeated decisions, and JPEG preview. ClawdTime's
`npm run check` passed typechecking, 872 tests, and build against the current
working tree (which also contains separate uncommitted work).

Secrets, upstream checkout, environments, call receipts, and generated output are
ignored. The original operational lab is kept intact outside this repository.
