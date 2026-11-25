# When something fails

Read against `chert 0.1.0-beta.23` and https://docs.trychert.com, 26 November 2026.

Start with `chert doctor --json` in the agent folder (for ClawdTime: in
`line/`), and with `chert guide fix`. Each failed check and each error says
what to do. An error is `{code, action}` on standard error. Exit codes: 0
success, 1 internal, 2 usage, 3 not ready or not signed in, 4 state, 5
unsupported runtime, 6 network or server, 130 cancelled.

## Sign-in and setup

| Code or symptom                        | What to do                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| `unsupported_runtime` (exit 5)         | Use Node 22.12 or later, 24 or 26                                              |
| `chert: command not found`             | Use the Node version that installed it, or `npx --yes @trychert/facetime@beta` |
| `login_required`                       | `chert login`. A browser sign-in lasts 30 days. New to Chert: `chert`          |
| `backend_request_forbidden`            | You need the owner or admin role on the project. Check `chert whoami`          |
| Onboarding exits 3                     | It is still waiting. Run the same command again: it resumes                    |
| `YOUR_` placeholders                   | Put your LiveKit values in `.env.local`, or run `chert livekit`                |
| `doctor` shows another project or file | Saved `chert setup` defaults are in effect. Ask before `chert setup --clear`   |
| Calls declined over timing (`clock`)   | Set the date and time of this computer automatically                           |

## The line

| Code                                 | What to do                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `line_in_use`                        | Another session holds the line. Wait for your slot, or ask that session to stop            |
| `line_in_call`                       | A call is in progress. Wait for it to end, then run `chert dev` again                      |
| `line_paused`                        | A project admin presses Enable calls on the line in the dashboard                          |
| `shared_line_paused`                 | Calls on your shared line are paused. Try again in a few minutes. `chert onboard --status` |
| `shared_allocation_inactive`         | The allocation expired or was released. `chert onboard --status`, then `chert onboard`     |
| `trial_line_released`                | No agent was connected. Run `chert onboard` for a line, then keep `chert dev` running      |
| `line_not_customer_decides`          | A project admin sets Routing to "Your webhook" and Assistant to "Unassigned" on the line   |
| `line_unacknowledged`                | The settings of the line are still being applied. Wait 30 s and run `chert dev` again      |
| `line_offline`, `worker_unavailable` | The line does not take calls right now. Try again in a minute. `chert doctor` shows when   |
| `agent_not_warm`, "has not joined"   | Start the agent first. `AGENT_NAME` must match its name, on the same LiveKit project       |
| `release_failed`                     | The line was not freed. Sign in again, run `chert dev`, and stop it once with Ctrl+C       |

## Calls

| Symptom                                 | What to do                                                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Declined, and no `call_incoming` record | Call from the joined iPhone, with FaceTime. Set its Caller ID to the phone number. Check `agent_warm` |
| The call ends after about 10 s          | The agent said nothing. Greet on the ready signal. Look for a model key or credit error               |
| The call ends at once                   | Two participants publish audio. Let only the agent speak                                              |
| No video                                | Call with FaceTime Video. Publish the camera from the participant that speaks                         |
| The call never ends                     | Hang up on the phone. If the line stays busy, an owner or admin ends it in the dashboard              |
| A second caller just rings              | One call at a time for each line                                                                      |

The reason of a call that ended badly is in [calls-and-video.md](calls-and-video.md).

## ClawdTime on its line

| Symptom                                 | What to do                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| "ClawdTime did not answer on this Mac"  | `clawdtime agents` must work in a terminal. Run `npm link` again                   |
| The screen video is black               | Grant Screen Recording to your terminal app, then `./host.sh restart`              |
| The wrong screen is shown               | Set `CLAWDTIME_LINE_SCREEN_DEVICE` in `line/.env.local` (see `.env.example`)       |
| It stops mid-sentence or answers itself | Run `./host.sh update`, and keep `CLAWDTIME_LINE_BARGE_IN` off                     |
| The sides of the picture are cut        | Say so on the call, or match `CLAWDTIME_LINE_FRAMING` to the framing of the line   |
| `clawdtime texts check` is refused      | Make a new project API key with read and write access. Check the project id        |
| Texts get no answer                     | Check `CLAWDTIME_OWNER_PHONE` and `CLAWDTIME_TEXT_WORD`. Only one `texts run` runs |
| `shared_reply_window_closed` (403)      | Free trial: your phone sends an ordinary text to the line first                    |
| The reach never calls                   | `clawdtime computer doctor` names the missing piece. Run `clawdtime connect`       |

More: "When something fails" in `SETUP_CLAWDTIME.md`.

## Keep

- Never delete `~/.chert` or `~/.chert/onboarding/` to clear an error. After
  "Stopped with N unfinished call(s)", the state under `~/.chert/dev/` stays.
- Never run a second onboarding to fix an uncertain result. Run the same
  command again.
- When you share output, take out keys, tokens, phone numbers and the contents
  of `.env.local`.
