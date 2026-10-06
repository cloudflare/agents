# Fake model

A scripted Anthropic Messages model on Workers. Create a room with a script,
give the room's URL to any agent as its model, and the model plays the script
the same way every time. It can hold or drop its stream at named checkpoints,
so a test can act while the agent is parked mid-reply.

## Quick start

With Claude Code as the agent:

```sh
URL=https://fake-model.agents-b8a.workers.dev    # or your own deployment

BASE=$(curl -s "$URL/rooms" -H "content-type: application/json" -d '{}' | jq -r .baseUrl)

ANTHROPIC_BASE_URL=$BASE ANTHROPIC_API_KEY=any \
  claude -p "[t1] Say hello." --model claude-sonnet-4-5
# Hello! How can I help you today?
```

Any API key and model name work. Requests must stream (`stream: true`).

## HTTP API

All bodies are JSON. Errors are `{ "error": "<why>" }`, except on the
model endpoint, which answers with Anthropic-style errors.

### `POST /rooms`: create a room

A room is one test's session with the model: its script, holds, drops, and a
log of what it saw. A room must exist before the model will answer in it.

```json
{
  "id": "my-test-1",
  "script": [ … ],
  "pauses": [{ "id": "t2.s0.b1.text.start" }, { "id": "t3.s0.done", "drop": true }],
  "continuation": "faithful"
}
```

| Field          | Default                                   | Meaning                                                                                                                                                                                                         |
| -------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | a random UUID                             | Letters, digits, `.`, `_` and `-`, up to 128 characters                                                                                                                                                         |
| `script`       | the [default script](#the-default-script) | See [Scripts](#scripts)                                                                                                                                                                                         |
| `pauses`       | none                                      | Checkpoints to hold at, or with `drop: true` to error the stream at                                                                                                                                             |
| `continuation` | `faithful`                                | How to answer a request to continue an interrupted reply: `faithful` streams the rest of the step; `restart` streams the whole step again with new tool call IDs, as a model that ignores the instruction would |

Returns `201`:

```json
{
  "id": "my-test-1",
  "baseUrl": "https://<worker>/rooms/my-test-1",
  "checkpoints": ["t1.s0.request", "t1.s0.b0.thinking.start", …]
}
```

`409` if the room exists, `400` if the body is invalid. A room's
configuration can't change: create another room instead.

### `POST /rooms/<id>/…/messages`: the model

Any path under the room ending in `/messages` is the Anthropic Messages
endpoint, so give a provider `baseUrl` (it adds `/v1/messages`) or
`baseUrl/v1` (it adds `/messages`), whichever it expects.

- `200` with an SSE stream of the reply.
- `400` (`invalid_request_error`) without `stream: true`.
- `404` (`not_found_error`) if the room doesn't exist.

Rejected requests and other paths under an existing room are logged in the
room's state, so a test can see what the agent tried.

### `GET /rooms/<id>`: what the room has seen

```json
{
  "paused": ["t2.s0.b1.text.start"],
  "fired": ["t2.s0.b1.text.start"],
  "requests": [
    {
      "at": 1791288032000,
      "turn": "t2",
      "step": 0,
      "outcome": "completed",
      "tail": ["user: text:[t2] Record alpha."]
    }
  ],
  "tools": { "alpha": 1 }
}
```

- `paused`: checkpoints held right now.
- `fired`: pauses that have fired. Each fires once.
- `requests`: one entry per model request, with:
  - `turn` and `step`: what it was matched to.
  - `reason`: why it wasn't matched, or why it was rejected.
  - `outcome`: `completed`, `dropped`, `cancelled` (the agent hung up) or `rejected`.
  - `continued`: it continued an interrupted reply. `restarted` means it did so by restarting the step.
  - `nothingLeft`: it asked to continue a reply that was already complete.
  - `tail`: a compact view of what the agent sent, from the turn's user message on.
- `tools`: tool probe counts, by key.

### `POST /rooms/<id>/release`: let a hold go

`{ "checkpoint": "t2.s0.b1.text.start" }`. The held stream or tool goes on.
Returns the room's state. Releasing a checkpoint that isn't held does nothing,
so release only after `paused` shows the hold.

### `POST /rooms/<id>/tool`: tool probe

`{ "key": "alpha" }`, called by a tool implementation while it runs. Optional.
The room counts the call, and if the script has a tool call with that `key`
input, holds at that turn's tool checkpoint when a pause names it.

## Checkpoints

Every step passes named checkpoints, in stream order. For step 0 of turn
`t2`, whose block 1 is text:

```
t2.s0.request              the request arrived, nothing streamed yet
t2.s0.b1.text.start        after the block's first delta
t2.s0.b1.text.end          after the block stops
t2.s0.done                 after message_stop
t2.tool.alpha              while a tool probes with key alpha
```

Block kinds are `thinking`, `text` and `tool`. `POST /rooms` returns every
checkpoint of the room's script.

- **Hold:** a pause without `drop` holds there until released.
- **Drop:** a pause with `drop: true` errors the response body there.
- **Once:** each pause fires once per room, so a retry streams straight
  through.

## How a request is matched

The model picks its reply from the request alone, never from a counter.

1. **Turn:** the newest user message containing `[<turn id>]` names the turn.
   A message naming several turns answers to the one latest in the script.
   Without a marker, the reply is a visible `(fake-model: no turn marker)`.
2. **Step:** each assistant message after that user message completes one
   step, so the request after a tool call gets the next step.
3. **Continuation:** an assistant message that stopped short of its step's text
   or tool calls didn't complete it. The next request gets the rest of the
   step under `faithful`, or the whole step again under `restart`. Text that
   the step's thinking starts with counts as thinking, since some agents
   resend an interrupted reply's reasoning as text.
4. **Nothing left:** a request that asks to continue (a user message without a
   marker) after the last step was complete gets an empty reply.

A retried request gets the same reply. Tool results don't change the reply:
the script says what the model says next.

## Scripts

A script is a list of turns. Each turn has an `id`, an optional `prompt`
(documentation only), and `steps`, one per model call. Each step is a list of
blocks:

```json
[
  {
    "id": "demo",
    "prompt": "[demo] What year is it?",
    "steps": [
      {
        "blocks": [
          {
            "kind": "thinking",
            "text": "I will check the date with the shell."
          },
          {
            "kind": "tool",
            "name": "Bash",
            "input": {
              "command": "date -u +%Y",
              "description": "Print the year"
            }
          }
        ]
      },
      {
        "blocks": [
          { "kind": "text", "text": "The shell answered, so I am done." }
        ]
      }
    ]
  }
]
```

Tool calls can name any tool the agent has, such as Claude Code's `Bash`
(with `--allowedTools Bash`). Tool call IDs are generated:
`toolu_<turn>_s<step>_b<block>`. A step with a tool call stops with
`stop_reason: "tool_use"`; others stop with `end_turn`.

## The default script

Used when a room is created without a script. It exercises the harness
features of `agents`.

| Turn | Prompt                                   | Steps                                                                      |
| ---- | ---------------------------------------- | -------------------------------------------------------------------------- |
| `t1` | `[t1] Say hello.`                        | Thinking, then text                                                        |
| `t2` | `[t2] Record alpha.`                     | Thinking, text, a `record` call; then text                                 |
| `t3` | `[t3] Record beta and gamma.`            | Thinking and two parallel `record` calls; then text                        |
| `t4` | `[t4] Record delta, with my approval.`   | Thinking and a `guarded_record` call, meant to be approved; then text      |
| `t5` | `[t5] Record epsilon, with my approval.` | A `guarded_record` call, meant to be rejected; then text                   |
| `t6` | `[t6] Ask my client for the zeta value.` | Thinking and a `client_lookup` call, meant to run on the client; then text |
| `t7` | `[t7] Record eta.`                       | Thinking and a `record` call; then text                                    |
| `t8` | `[t8] Then say goodbye.`                 | Text, meant to be sent while `t7`'s tool runs                              |

Each tool call's input is `{ "key": "<name>" }`, so tools that call the probe
can be held at `t2.tool.alpha` and so on.

## From TypeScript

`ModelControl` wraps the API:

```ts
import { ModelControl } from "@cloudflare/fake-model";

const model = new ModelControl("https://fake-model.example.workers.dev");
const room = await model.create({ pauses: [{ id: "t2.s0.b1.text.start" }] });
// …point the agent at room.baseUrl and send "[t2] Record alpha."…
await model.release(room.id, "t2.s0.b1.text.start");
const { requests, tools } = await model.state(room.id);
```

`headers` in its options adds headers per request, such as Access
credentials. `@cloudflare/fake-model/script` exports the default script and
the checkpoint helpers.

## Deploying

```sh
pnpm deploy                               # Worker "fake-model"
FAKE_MODEL_NAME=my-model pnpm deploy      # another name
pnpm dev                                  # locally
```

Rooms persist in their Durable Objects. Anyone who can reach the Worker can
create rooms, and anyone who knows a room's ID can read and release it, so
prefer generated IDs on a public deployment.
