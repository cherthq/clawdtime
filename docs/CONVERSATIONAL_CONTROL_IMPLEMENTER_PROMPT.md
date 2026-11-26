# Prompt for the next implementer

Copy the following into the new implementation chat. Keep this file uncommitted.

---

You are the coordinating implementer for ClawdTime in `/Users/garygao/clawdtime`.
Context yourself, then implement the approved conversational-control architecture.
Do not stop at a proposal or another plan. Work through implementation, integration,
tests, deployment preparation and the physical acceptance that is actually possible.

The authoritative new plan is:
`/Users/garygao/clawdtime/docs/CONVERSATIONAL_CONTROL_IMPLEMENTATION_PLAN.md`

The user approved this product behavior:

- BOTH FaceTime voice and iMessage have a responsive conversational layer.
- Conversation can clarify, acknowledge, receive corrections and discuss progress
  while an execution agent works asynchronously on submitted requests.
- Both channels use the same job state and submit/status/revise/cancel interface.
- The execution agent can use native CUA or bounded ClawdTime custom CUA. Implement
  eligible adapters and measure latency plus verified success before choosing a
  default. A faster acknowledgment must not hide slow or nonexistent execution.
- Keep the existing TypeScript/Python/Swift/LiveKit stack. Prototype GPT-Live with
  client delegation for voice, and a fast text frontend for iMessage. Verify the
  current official APIs, account availability and installed package compatibility.
- Build real text-only task/control behavior under explicit device/session grants;
  do not fabricate a FaceTime call or silently bypass existing authority checks.

First read applicable AGENTS.md instructions, IMPLEMENTATION_PLAN.md and
SESSION_PROMPT.md completely, then the new plan and the latest source/status docs
it lists. The old plans contain historical baselines and synchronous architecture.
The user's new decision supersedes the old rule that this coding chat must produce
every spoken/text reply, while preserving session identity, native approvals,
exclusive control, local Stop, freshness, receipt and unknown-outcome safeguards.

Inspect Git status, branches and recent changes before editing. At handoff HEAD
was `a5af1f3` on `improvements`. Preserve unmerged work; follow the repo's main or
generic descriptive branch policy and never use `codex/` branches. Preserve the
pre-existing untracked `docs/NATIVE_PHONE_CONTROL_DEMO_PLAN.md`; remote iPhone
control is out of scope. Keep the new implementation plan and this prompt
UNCOMMITTED, even if you commit implementation code. Do not use `git add .`.

Read the actual implementation in src/contracts.ts, src/app.ts, src/runtime.ts,
src/attention/conversation.ts, src/control/execution.ts, transport/storage,
connectors/shared/{client,conversation,setup-session,timing,inspection}.ts,
media/{server,policy,voice_interaction,devices,captions}.py, gateway and relevant
Mac sources/tests. Paths are starting points; inspect dependencies rather than
assuming the new broker or a native runner API already exists.

The previous live test found:

- Real iMessage command/result delivery passed. Basic voice in both directions
  passed after a startup fix; full-duplex speakerphone acceptance did not.
- Backend input → this host's acknowledgment took 8.6–15 s. Individual HTTP calls
  were around 0.1 s; one TTS first-publication interval was 353 ms; local native
  input plus UI observation took about 0.5 s. The main demonstrated delay is the
  host/model/tool orchestration path. Fresh screen capture was about 1.5 fps.
- The original drop was `bridge_remote_audio_timeout`; the external worker needs
  audible output during startup. Preserve the once-only, policy-bound greeting
  behavior from `f7611d2` or prove an equivalent new-model startup path.
- The successful second call ended intentionally with provider `remote_ended`.
  Prior foreground bridges are closed; no prior call authorization can be reused.
- Local `a5af1f3` fixes inspector TTS pairing across capture restarts using explicit
  playback generation. Preserve it; do not combine unrelated clocks/generations.

Use the lead plus specialist organization required by SESSION_PROMPT.md. Define
contracts and file ownership before parallel edits. Lead owns shared contracts,
routes/control/manifests/integration and operational work. Transport owns durable
jobs and Messages transport, media/Mac owns audio/helper/gateway, and connector
owns actual runner integration, native capabilities and timing. Review each
other's correction, cancellation and unknown-effect paths before release.

Start with two feasibility proofs and a vertical slice:

1. A documented programmatic execution connection can accept a request, report
   progress and return a verified result. Do not assume MCP can wake any idle
   desktop chat or that a daemon can call this chat's native CUA tools. If the
   host cannot support it, provide an explicitly identified API-managed runner
   option rather than silently replacing the user's original session.
2. A qualified GPT-Live/LiveKit adapter supports continuous conversation while a
   deliberately slow job runs. Client delegation requires constructing context
   from real conversation events; the event is not a trusted command object.
3. Implement broker + iMessage conversation → clarification → durable submission
   → execution → observed result first, then connect voice to the same contracts.

Provide a bounded fast desktop execution workflow for simple actions and route
longer coding/file tasks to the selected agent. Both use the same device arbiter.
Native/custom adapters must observe, propose a bounded action, execute once,
verify and release. No simultaneous native/custom input, no fallback after an
unknown action, and no execution of arbitrary generated scripts. Screen context
comes from the executor; the current LiveKit GPT-Live adapter is audio-only.

Keep one conversational output owner per session. Worker results are structured
facts, not another independent TTS/iMessage sender. Correctly distinguish queued,
running, waiting for approval, verified complete, canceled and unknown. Preserve
cross-channel instruction ordering and stale-result suppression. Interrupting
speech is separate from canceling a job; local Stop remains authoritative. Do not
flip isolation flags merely to make duplex tests pass. Bound and measure playback
queues through the external FaceTime worker and actual handset.

Implement the measurement and acceptance matrix in the plan. Compare supported
native/custom operations on the same fixtures, with at least 30 trials per backend
and with/without an active call. Include failure/cancellation/unknown outcomes,
frame age, model/tool versions and verified success. Target p95 first useful
audible response ≤2 s, interruption cutoff ≤300 ms, simple typing result ≤3 s;
these are goals to prove, not claims to put in release notes without evidence.
Measure Messages provider delivery separately from frontend processing.

Run npm run check plus relevant Python/gateway/Swift validation. Add meaningful
lifecycle, authorization, retry/restart, correction and isolation regressions.
Update README, GUIDE, STATUS, connector/media docs and applicable skills to match
what actually works. Do not leave conflicting old instructions as the primary
agent workflow. Keep old live sessions immutable and migrate new sessions through
explicit capabilities/versions and rollout flags.

Default to simulation/standby. Only you as lead may handle secrets, deploy,
install/restart components or coordinate a live line. Never modify Apple Teams
or sibling chert-facetime; never copy customer/runtime data, secrets, screens or
audio into source or test fixtures. Do not change line ownership from historical
names in old docs. Freshly audit the existing dedicated binding, idle calls,
pending/unknown effects and current deployments before any rollout. Respect
existing user authorization without repeating routine permission questions.
Specific new calls require current readiness/authorization; do not redial from
the earlier test's approval. No new paid plans/accounts are implicitly authorized.

Finish all independent work before surfacing an external prerequisite. If a host
API, provider access, upstream queue-control feature or physical test blocks a
part, identify it precisely, leave that path unavailable, and continue the rest.
Do not claim production readiness from synthetic tests or quick canned replies.

Your final handoff should include implementation/source versions, changed behavior,
tests, actual native/custom latency and success comparison, physical voice/text
results, remaining concrete blockers, migration/rollback and exact next commands.
Keep the two planning/handoff Markdown files uncommitted as requested.
