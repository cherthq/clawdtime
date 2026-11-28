# Call recording

Call recording is an internal feature for experiments with clear consent. It
records the calls of one line: the times, the transcript, the audio of both
sides and the caller's video. It is off on every line. Turn it on for a test
line only.

## What a recorded call holds

| Part         | File              | What it is                                                                                          |
| ------------ | ----------------- | --------------------------------------------------------------------------------------------------- |
| Record       | `call.json`       | The line, the start and end times, the duration and the parts                                       |
| Transcript   | `transcript.json` | Each turn of the caller and the agent, with its time in the call                                    |
| Caller audio | `caller.wav`      | The caller's voice. 16-bit PCM, one channel, 24 kHz                                                 |
| Agent audio  | `agent.wav`       | The agent's voice, on the same clock                                                                |
| Both sides   | `mixed.wav`       | The two voices in one file                                                                          |
| Caller video | `video-1.mp4`     | The caller's video, H.264, 10 pictures each second. A new file starts when the picture size changes |

When a part cannot be recorded, the record says why in `missing`. The call
goes on. For example: "The caller sent no video." or "ffmpeg is not on this
Mac, so video is not recorded."

The agent's own picture (the stone or the shared screen) is not recorded.

## How consent works

1. The agent says this line first: "This call is recorded. Say stop recording
   to turn it off."
2. The recording starts with the first sound of that line. Nothing before it
   is recorded.
3. The caller can say "stop recording" at any time. Every part stops at once.
   The call goes on. The agent says: "Recording is off. Nothing more of this
   call is recorded." What was recorded before the stop is kept.
4. When the call does not greet (no ready signal), the agent never says the
   line, and nothing of the call is recorded.

These phrases also stop it: "stop the recording", "turn off the recording",
"don't record". A wrong match only stops a recording. It never starts one.

Only an ordinary call on the line is recorded. A call that ClawdTime places to
you, and a call on a shared line, are never recorded.

## Turn it on for the test line

Do these steps on the Mac of the test line. Do not do them on a customer line.

1. Add these lines to `line/.env.local` of the test line:

   ```sh
   CLAWDTIME_LINE_RECORDING=on
   CLAWDTIME_LINE_RECORDING_LABEL=test-line
   ```

2. Restart the line agent: `./host.sh restart` in the `line` folder. Do it
   when no call runs.
3. Call the line. The agent says the consent line first.
4. See the calls: `clawdtime recordings list`.

To turn it off, remove the line or set `CLAWDTIME_LINE_RECORDING=off`, then
restart the line agent. The calls that were recorded stay until their
retention date.

## Settings

All settings go in `line/.env.local`. Only the exact word `on` turns recording
on. A setting that is not valid turns recording off, and the line log gets a
code. The call itself goes on as before.

| Setting                          | Default        | What it does                                                 |
| -------------------------------- | -------------- | ------------------------------------------------------------ |
| `CLAWDTIME_LINE_RECORDING`       | `off`          | `on` records the calls of this line                          |
| `CLAWDTIME_LINE_RECORDING_LABEL` | the agent name | The name of the line in the records                          |
| `CLAWDTIME_LINE_RECORDING_DAYS`  | `30`           | Days to keep each call, 1 to 365                             |
| `CLAWDTIME_LINE_RECORDING_VIDEO` | `on`           | `off` records no video                                       |
| `CLAWDTIME_LINE_RECORDING_DIR`   | see below      | The recordings folder. An absolute path outside the checkout |
| `CLAWDTIME_LINE_FFMPEG`          | `ffmpeg`       | The ffmpeg command for the video                             |

The recordings folder is `recordings` in the line's state folder:
`~/.local/share/clawdtime/line/recordings`, or `$CLAWDTIME_LINE_STATE/recordings`.
A folder in the ClawdTime checkout is refused.

## Where the files are, and who can read them

- Each call is a folder with a name such as `20261128-101500-a1b2c3`.
- The recordings folder and each call folder are for their owner only (`700`).
  Each file is for its owner only (`600`). A recordings folder that others can
  read is not used, and nothing is recorded.
- The files never go into the repository and never leave the Mac.
- The line log gets codes only, never a word of a call.

## Retention

Each call keeps its own end date, `keepUntil`: its start plus the days of
`CLAWDTIME_LINE_RECORDING_DAYS` at that time. At the end of each call, the
line agent removes the calls after their end date. The admin page and
`clawdtime recordings list` also remove them before they show the list. A
change of the setting applies to new calls only.

## The admin page

The desktop service serves the admin page on 127.0.0.1:
`http://127.0.0.1:3320/admin/recordings`. It shows the list of calls, the
transcript of a call, the audio and video players, a download for each file
and a zip of each call. The page only reads. It cannot delete a call.

The page has its own admin token. It is not the panel token. To turn the page
on:

```sh
clawdtime recordings admin          # makes the token and shows the address
clawdtime recordings admin --open   # opens the page and signs you in
clawdtime recordings admin --new    # makes a new token; the old one stops working
```

The token is in `recordings-admin.json` in the desktop state folder, for its
owner only. The command never prints it. After you sign in, a session lasts 8
hours. The page refuses a host name other than 127.0.0.1 and localhost.

When the line uses `CLAWDTIME_LINE_STATE` or `CLAWDTIME_LINE_RECORDING_DIR`,
give the same setting to the desktop service.

## The command

```sh
clawdtime recordings list [--json]
clawdtime recordings show CALL [--json]
clawdtime recordings export CALL [--to FILE]
clawdtime recordings delete CALL [--yes]
```

`delete` asks before it removes a call. With no terminal, it needs `--yes`.
`export` writes a zip file for its owner only and never writes over a file.
Add `--dir FOLDER` to read another recordings folder.

## How it works

- `line/recording.mjs` records one call. The line agent makes it for each
  ordinary call when the switch is on. It gets the session's conversation
  items for the transcript, a copy of each audio frame that the agent sends,
  and its own audio stream of the caller's track. For the video it subscribes
  to the caller's video track and sends the newest picture to ffmpeg ten times
  each second.
- `line/recording-store.mjs` writes the files. It is the contract with the
  read side.
- `line/recording-video.mjs` runs ffmpeg for the video.
- `src/recordings/store.ts` reads, lists, zips, deletes and prunes the calls.
- `src/recordings/admin.ts` and `src/recordings/page.ts` are the admin page.
- `cli/recordings.ts` is the command.

LiveKit egress can also record a room or a track, but it writes to cloud
storage or a WebSocket server. This feature keeps the files on the Mac, so it
records in the agent.

## Tests

```sh
cd line && node --test recording.test.mjs   # the switch, consent, stop, audio, video, retention
npx vitest run tests/recordings.test.ts      # the admin page, the downloads and the command
```
