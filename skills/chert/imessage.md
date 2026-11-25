# Texts on a Chert line

Read against `chert 0.1.0-beta.23`, https://docs.trychert.com and the ClawdTime
code in `connectors/agents/texts.ts`, 26 November 2026.

The number of your line also takes iMessage texts. A phone that is joined to
your project can text the line, and your program can read those texts and
answer them. This needs no webhook and no public address: the program reads the
messages of the project every few seconds.

## The project API key

The `chert` sign-in is for the CLI. The API needs a project API key.

1. Open the developer page of your project: https://app.trychert.com/developer.
2. Make a project API key with read and write access. Read is the scope
   `facetime:read` (GET). Write is `facetime:write` (POST).
3. Copy the key at once. The page shows a new key only for a short time, and
   never again. Revoke a key on the same page.
4. `chert whoami --json` prints the id of the project as `project_id`.

Keep the key in the environment of the program that uses it. Keep it out of
files that you share, out of your shell history, out of logs and out of the
chat.

Each request carries two headers:

```http
Authorization: Bearer YOUR_PROJECT_API_KEY
X-Chert-Project-Id: YOUR_PROJECT_ID
```

## Read and send

ClawdTime uses the address `https://app.trychert.com/api/v1`. `CHERT_API_BASE`
changes it, to an `https://` address only.

| Request                             | What it does                                         |
| ----------------------------------- | ---------------------------------------------------- |
| `GET /shared-messages`              | The newest 50 messages of the project on its line    |
| `POST /shared-messages`             | Sends `{"line_id","recipient","text"}` from the line |
| `POST /shared-groups`               | Makes a group text and sends its first text          |
| `POST /shared-groups/{id}/messages` | Sends a follow-up to the group                       |
| `GET /shared-groups/{id}/messages`  | The history and replies of the group                 |

- Each message in the list has `id`, `line_id`, `direction`,
  `masked_recipient`, `created_at` and `text`. Inbound texts have
  `direction: "inbound"`.
- A text has up to 4,000 characters. The recipient is a phone number in
  international form, such as `+15551234567`.
- Send an `Idempotency-Key` with each POST (8 to 200 characters). Make it from
  the id of the message that you answer, so that a retry never sends a second
  text. A repeated key returns `shared_idempotency_conflict`: the text went out
  already.
- A `429` or a `5xx` answer to a send leaves the outcome unknown. Do not send
  again with a new key.
- Images: JPEG or PNG, one for each message, up to 4 MiB. Check
  `data.image_capability` in the message list before you offer one.
- A group text needs at least two distinct numbers. Each recipient counts as
  one message.

## The reply window on the free trial

- On the free trial, the line can text a phone only within 24 hours of that
  phone's last individual text to the line. Otherwise the API answers
  `shared_reply_window_closed` (403). The phone sends an ordinary text, such as
  `hello`, to open the window again. The join phrase does not count.
- A Shared plan has no reply window.

## Joining a phone

- A phone joins your project on the line. The first phone joins in onboarding:
  it sends the 6-digit code by iMessage. Other phones send the join phrase of
  your project, from the messages page, to the line.
- Joining by code lets any phone that knows the phrase join. On the messages
  page, https://app.trychert.com/imessage, turn it off when only your own phone
  may text the line. ClawdTime needs that.

## The owner check

The service gives no more of a sender than the last four digits of its number,
in `masked_recipient`. So the list of joined phones of the project is the real
guard. Keep it to your own phone.

ClawdTime adds its own checks (`clawdtime texts run`):

- A text counts only when it comes from a phone that is joined to the project,
  and whose number ends with the last four digits of `CLAWDTIME_OWNER_PHONE`.
- Answers go only to `CLAWDTIME_OWNER_PHONE`, never to a number from a message.
- With `CLAWDTIME_TEXT_WORD` (a private word of four letters or more), a text
  counts only when it starts with that word. A text without it gets no answer.
- One text gets one answer, also after a restart. A text that is more than ten
  minutes old when ClawdTime first sees it is not run.

## The demo agent

On a trial or Shared line, the first text after a quiet day can also get a
second answer from the demo agent of the line.

## The Messaging API

Chert also has a Messaging API, with its own credentials, webhooks and event
stream: https://docs.trychert.com/api/overview. The ClawdTime text channel does
not use it.
