# Media presentation and isolated checks

The existing compositor displays ephemeral human captions and one spoken reply per
turn. “Backend accepted” means the media callback was accepted; “Received by agent”
requires the coding session's acknowledgment. Visual-only activity, native approval,
and reported/unverified/unresolved outcomes use authenticated panel metadata. They
never dispatch speech, input, Messages, or call cleanup.

Activity version 1 requires the latest fresh policy's exact presentation binding
(session, call, member, device, display). Unsupported or malformed optional activity
is ignored; unknown fields are stripped. At most 20 summaries of 160 Unicode code
points and 640 UTF-8 bytes are accepted. The JSON request envelope is bounded to 64 KiB (including escaped Unicode); field
limits remain unchanged. The outer panel freshness lasts at most five
seconds. Repeated identical metadata refreshes connection freshness only: it cannot
extend the fixed text expiry or restore cleared text. Outcome summaries last at most
60 seconds; ordinary summaries at most ten minutes. Policy loss, mute, Stop and
close clear transient content; no presentation text enters the media ledger.

The gateway advertises presentation support only when the helper reports version 1.
When forwarding to older helpers it strips optional presentation fields. Readiness
queries remain metadata-only, and never grant capture or input authority.

Speech diagnostics retain a 64-event allowlisted ring and bounded counters. A random
`processId` distinguishes monotonic clock scopes, with `generation` separating
capture resets. A backward monotonic clock or 24-hour elapsed-time bound starts
a fresh process scope instead of clamping durations. A segment's opaque `correlationId` is the first 24 hex characters of
SHA-256 over `mediaSessionId + ':' + segmentId`; reply playback uses the utterance
ID instead. UTC observations establish cross-process order, not precise latency.
No transcripts, audio, error bodies, phone numbers or paths are accepted by the new
fields.

Run isolated checks from the repository root:

```sh
media/.venv/bin/python -m unittest discover -s media -p 'test_*.py'
media/.venv/bin/python -m unittest discover -s gateway -p 'test_*.py'
media/.venv/bin/python media/preview_activity.py /tmp/clawdtime-phone-preview
```

The preview writes only synthetic portrait/landscape PNGs with light/dark desktop
backgrounds. It does not import a server, read installed configuration, access a
microphone/screen, or connect to a service. Keep generated images outside Git.
Review the generated contact sheet and full landscape images for readability.
Physical handset readability, audio timing, barge-in, real native input, and cleanup
remain separate, explicitly authorized acceptance work. Half-duplex speech is
unchanged: the microphone is paused during agent playback.
