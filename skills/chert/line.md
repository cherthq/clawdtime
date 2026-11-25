# A Chert line

Read against `chert 0.1.0-beta.23` and https://docs.trychert.com, 26 November 2026.

## What a line is

- A Chert line is a phone number that receives FaceTime calls and iMessage
  texts. Chert runs the line. Your agent runs where you run it.
- `chert dev` runs on your computer and connects your LiveKit agent to the line
  of your project. Each FaceTime call to the line then joins a LiveKit room with
  your agent in it. The caller needs only FaceTime.
- A line belongs to a project. `chert dev` needs the owner or admin role on
  that project. `chert whoami` shows your project and your role.
- One line answers one call at a time, and one `chert dev` session holds it.
  More calls at the same time need more lines, each with its own agent session.

## Plans

| Plan       | In public terms                                                                  |
| ---------- | -------------------------------------------------------------------------------- |
| Free trial | The plan that onboarding keeps unless you choose another. Its allowance is below |
| Shared     | A paid plan. Teams share the line in time slots, one call at a time              |
| Dedicated  | A line of your own. The CLI says that it is not on sale yet                      |

- The free trial, as `chert context` states it: 50 FaceTime minutes (5
  minutes a call) and unlimited inbound iMessage (up to 50 messages an hour),
  valid for 24 hours from activation.
- On the free trial, the line can text a phone only within 24 hours of that
  phone's last text. A Shared plan has no such window.
- On Free and Shared lines, each distinct person that you call or text counts
  toward the limit of 100 contacts, across FaceTime and messaging.
- Group calls work on Free, Shared and Dedicated lines. On Free and Shared, each
  person in the group needs a phone that is joined for the project and the line.
- `chert plan` lists the plans with their current prices and limits, and the
  billing page of your project. `chert plan shared` opens that page ready for
  checkout. A project owner or admin presses Continue to checkout there. The
  CLI never buys or changes a plan itself.

## Get a line

Run `chert` (or `chert onboard`). The person does these steps:

1. Sign in, or make an account, in the browser that the CLI opens.
2. Enter a name and a phone number.
3. Send the 6-digit code that the page shows, as an iMessage, from that iPhone
   to the number that the page shows. Not an SMS, and not from a Mac or an
   email address. The line answers "Verified". The phone is now joined.
4. Take the demo call, or skip it. Then choose: connect an agent, build one, or
   describe one in a sentence for Chert to run.

Useful flags of `chert onboard`:

| Flag                              | Use                                                     |
| --------------------------------- | ------------------------------------------------------- |
| `--plan trial\|shared\|dedicated` | Answers the plan question. `shared` opens checkout      |
| `--stack demo\|livekit`           | Chert's demo agent, or your own LiveKit agent           |
| `--livekit chert\|own`            | For your own agent: Chert's LiveKit or your own project |
| `--describe "SENTENCE"`           | After the demo, Chert runs an agent from this sentence  |
| `--skip-demo`                     | Stops after the questions, with no demo call            |
| `--no-browser`                    | Prints the browser address, for a remote shell          |
| `--status`                        | Reads the saved state of onboarding. It starts nothing  |
| `--wait SECONDS`                  | Caps each wait, 0 to 3600                               |

- Stop with Ctrl+C. Run the same command again to go on: it resumes the same
  session. Exit code 3 means not ready yet, not failed.
- `--restart` starts again only after an expired, cancelled or completed
  session. `--cancel` cancels new onboarding work.
- Keep `chert dev` running on a trial line. With no agent connected, the trial
  line goes back to the pool (`trial_line_released`). Your trial minutes stay.
  Run `chert onboard` to get a line again. The number may change.

## Join a phone

- On a trial or Shared line, Chert sends a call to your project only when it
  comes from a phone that is joined to the project. A call from another number
  is declined before it reaches your project.
- On the iPhone, set the FaceTime Caller ID to the phone number, not to an
  email address.
- Other phones join with the join phrase of your project, from the messages
  page of the dashboard. Each phone sends the phrase to the line and waits for
  the confirmation. For ClawdTime, keep the list to your own phone and turn off
  joining by code: see [imessage.md](imessage.md).

## Sign in on another computer

```sh
chert login              # approve this computer in the browser; 30 days
chert login --device     # in a remote shell: open the address on any device
chert whoami             # the project and your role
chert logout             # sign out and revoke this computer; stop chert dev first
```

- One sign-in covers one project. With several projects, pass `--project UUID`.
- `chert dev` reads the LiveKit values in this order: the shell environment,
  `--env-file`, the path that `chert setup` saved, then `.env.local`, then
  `.env` in this folder. `chert setup --clear` removes saved defaults. It does
  not sign you out or free the line.
- Copy the agent folder to the other computer, never `~/.chert`.

## Share a line in time slots

- Agree time slots with the other teams. Start a slot with
  `chert dev --until HH:MM` or `--minutes N` (1 to 240). A minute before the
  end it warns you. At the end it frees the line, after any call in progress.
- When another session holds the line, `chert dev` stops with `line_in_use` and
  names the holder and until when. During a call it stops with `line_in_call`.
- A session that is no longer connected (a closed laptop, a crash) is replaced
  by a plain `chert dev`. Use `--takeover` only for a live holder who agrees,
  and only with no call in progress.
- Without a slot, press Ctrl+C at the end and wait for "Stopped. The line no
  longer routes to this agent." Closing the terminal frees the line too.
  Closing the laptop does not.
