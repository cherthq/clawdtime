# Calls and video

Read against `chert 0.1.0-beta.23` and https://docs.trychert.com, 26 November 2026.

## Take the first call

1. Wait for `agent_warm` from `chert dev`.
2. From the joined iPhone, FaceTime the number of the line. Use FaceTime Audio
   for a voice agent and FaceTime Video for an agent with video.
3. The agent greets once FaceTime is ready. Say hello, ask a follow-up and
   interrupt once. Hang up.
4. Wait for the next `agent_warm`, call again, and check that the second call
   starts fresh.
5. The person confirms two-way audio, and the video when there is video. A
   passing `chert doctor` and the call records do not replace this test.

The records of one call, in order: `call_incoming`, `call_accepted`,
`call_bridge_ready` (with "FaceTime is ready."), `call_media`, `call_ended`. A
call that the line refused before it reached your project leaves no
`call_incoming`: see [troubleshooting.md](troubleshooting.md).

## Video

- The caller calls with FaceTime Video.
- Publish a camera track from the participant that speaks. The line takes audio
  from the one participant that publishes it, and video only from that same
  participant.
- With no video from your agent, the caller sees the default picture of the
  line.
- A few seconds into each call, `chert dev` says what the line takes, for
  example: Video and audio are coming from "agent-AJ_x1y2". Read that media line
  on your first call.
- An avatar service can join the room as a third participant and publish both
  the voice and the face. That fits the rule above when the audio of your own
  agent stays off the room, so that only the avatar speaks. Each such service
  needs its own account and key.

## Framing

- Video framing is a setting of each line, on the page of the line in the
  dashboard. Fit, the default, sends the whole picture. Fill turns the video
  upright and sends only the middle of the picture, so that it fills a phone
  held upright.
- The framing is fixed for a call. Saving a new setting does not prove that a
  call in progress uses it.
- An agent that draws for Fill must know it. The ClawdTime line agent reads
  `CLAWDTIME_LINE_FRAMING=fill` from `line/.env.local`.

## The caller's video

- Showing a face and seeing the caller are separate. The caller's camera
  arrives only when the line captures caller video. That is a capability of
  its own: check that it is on for your line before you build on it.
- The caller joins as `chert-bridge-<call id>` and publishes
  `facetime-remote-audio`, and `facetime-remote-video` when the line captures
  caller video. Check the kind of each track, not only its name.
- The capture can show the controls, names or self view of the FaceTime
  window. It is not always a raw camera picture. A muted camera or a lost track
  is not a current picture.
- In a group call all speakers share one mixed `facetime-remote-audio` track.

## Place a call: the Calls API

An outbound call needs a project API key with write access (see
[imessage.md](imessage.md) for the key). The public docs give the address
`https://facetime.trychert.com/api/v1`.

1. Join the agent to a room in your own LiveKit project with exactly one
   unmuted audio track, and keep it silent. Turn off any greeting on room
   join: the line joins before the person answers. For video, publish the video
   track before you dial.
2. Make a bridge token for that one room, with a separate identity that can
   join, publish and subscribe. It must have more than 90 seconds left, and a
   lifetime of at most 2 hours.
3. Show the person the exact recipient and purpose, and get a fresh yes.
4. Send the request:

```http
POST https://facetime.trychert.com/api/v1/calls
Authorization: Bearer YOUR_PROJECT_API_KEY
X-Chert-Project-Id: YOUR_PROJECT_ID
Idempotency-Key: A_UNIQUE_KEY_OF_8_TO_200_CHARACTERS
Content-Type: application/json

{"direction":"outbound","mode":"customer_managed","line_id":"LINE_UUID",
 "destination":"+15551234567","destination_type":"phone",
 "media":{"audio":true,"video":true},
 "livekit_url":"wss://YOUR_PROJECT.livekit.cloud",
 "participant_token":"BRIDGE_TOKEN","remote_participant_identity":"AGENT_IDENTITY"}
```

5. A `201` means that the call is allocated, not dialed or answered. Keep
   `data.id`. Poll `GET /api/v1/calls/{id}` and `GET /api/v1/calls/{id}/events`.
6. Greet once on `bridge_ready`. A room join, the `201` and an `active` status
   are not the signal.
7. To hang up, send `POST /api/v1/calls/{id}/end` with a new idempotency key. A
   `202` acknowledges the request. Keep polling until the call ends.

Rules:

- Retry a lost request with the same body and the same key: it returns the
  first call. A different body with the same key returns `409`. Never change
  the key on a retry: that can place a second call.
- Chert does not try another line when this one is not available.
- On Free and Shared lines, you can call only phones that are joined for the
  project and the line. Outbound video needs a line with outbound video.
- `"media":{"audio":true,"video":false}` places a FaceTime Audio call.
- `"when_busy":"queue"` waits up to two minutes for a busy shared line. A `202`
  with `queued: true` means waiting, not placed. Poll
  `GET /api/v1/calls/queue/{queue_id}`. At `ready`, send the first request
  again with the same key.
- Read history with `GET /api/v1/calls`, and a transcript, where one was
  recorded, with `GET /api/v1/calls/{id}/transcript`.

## Why a call ended

A call that failed carries `terminal_reason` and `terminal_detail`, in the call
history of the dashboard and in `GET /api/v1/calls/{id}`.

| What you see          | Reason                                                   | What it means                                            |
| --------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| ended: no agent audio | `remote_audio_timeout`, `bridge_remote_audio_timeout`    | No agent audio within 10 s of `bridge_ready`             |
| ended: agent absent   | `participant_not_found`, `bridge_expected_track_timeout` | The agent did not join and publish audio in time         |
| ended: declined       | `customer_declined`                                      | Your own webhook answered decline                        |
| ended: not answered   | `outbound_not_answered`                                  | The person you called did not answer                     |
| ended: not connected  | `outbound_failed`                                        | The outgoing call failed before it connected. Call again |
| ended: restart        | `worker_restarted`                                       | The calling service restarted during the call            |
| ended: line not ready | `line_not_accepting`                                     | The line did not take calls then. See `chert doctor`     |
| ended: caller video   | `caller_video_` and a cause                              | The caller's video could not reach your agent            |

## Limits

- One active call for each line.
- The agent speaks within 10 seconds of `bridge_ready`.
- A webhook that decides an inbound call has 5 seconds by default. A missing or
  late answer declines the call.
- A bridge token lives at most 2 hours (7,200 seconds).
- An `Idempotency-Key` has 8 to 200 characters.
