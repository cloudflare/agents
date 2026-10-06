# Fake model

A scripted Anthropic Messages model on Workers. Give it to any agent or
harness as a model URL and it plays a fixed conversation the same way every
time. It can hold or drop its stream at named points, so a test can act while
the agent is parked mid-reply. It was built for the harness gauntlet, a fault-injection suite for
`AgentHarness` implementations.

## Using it as a model

Point an Anthropic provider at a room's base URL:

```
https://<worker>/c/<room>/v1
```

Any API key works. Any path ending in `/messages` is accepted, so providers
that add `/v1/messages` themselves can use `https://<worker>/c/<room>`.
Requests must stream (`stream: true`); others get a 400.

Each room is a separate `Cell` Durable Object with its own configuration,
request log and counters. Use one room per test.

## What it says

`src/script.ts` holds an eight-turn conversation: text, a server tool, two
parallel tools, an approved tool, a rejected tool, a client tool, a server
tool, and a follow-up sent while that tool runs. Each reply has reasoning,
text and tool blocks. Send the turn's text (it starts with a marker like
`[t2]`) as the user message.

The model picks its reply from the request, not from a counter. The newest
user message with a `[tN]` marker names the turn, and the assistant messages
after it name the step. So:

- a retried request gets the same reply;
- an agent that keeps an interrupted reply and asks the model to continue
  gets the rest of the step, without repeating the reply so far. Text that the
  step's thinking starts with counts as thinking, since some agents resend
  interrupted reasoning as text;
- asked to continue a reply that was already complete, it answers with an
  empty message;
- a request the script doesn't cover gets a visible `(fake-model: …)` reply.

The tools it calls are `record` (`{ key }`), `guarded_record` (meant to need
approval) and `client_lookup` (meant to run on the client). Register tools
with those names to let the conversation proceed.

## Checkpoints

Every step passes named checkpoints, in stream order:

```
t2.s0.request              the request arrived, nothing streamed yet
t2.s0.b1.text.start        after the first delta of block 1 (a text block)
t2.s0.b1.text.end          after block 1 stops
t2.s0.done                 after message_stop
t2.tool.alpha              while the record tool for key alpha runs (see below)
```

`modelCheckpoints` and `checkpointsFor` in `src/script.ts` list them.

## Control API

```
GET  /control/<room>             what the room has seen
POST /control/<room>/configure   { pauses: [{ id, drop? }], continuation? }
POST /control/<room>/release     { id }
POST /c/<room>/tool              { key }: a server tool is running
```

- **Hold:** a pause without `drop` holds the stream (or the tool) at that
  checkpoint until you release it.
- **Drop:** a pause with `drop: true` errors the response body there instead.
- **Fires once:** each pause fires only once, so a retry streams straight
  through.
- **Continuation policy:** `continuation` sets how the model answers a request
  to continue an interrupted reply:
  - `faithful` (the default) streams the rest of the step.
  - `restart` streams the whole step again, thinking included, with new tool
    call IDs, as a model that ignores the instruction would.
- **Tool probe:** `/c/<room>/tool` is optional. A tool that calls it with its
  `key` is counted, and can be held at its `tN.tool.<key>` checkpoint.

The state holds the requests (turn, step, outcome, whether it continued, and a
compact view of what was sent), the fired and held checkpoints, and tool
counts. `ModelControl` (the package entry) wraps the API:

```ts
import { ModelControl } from "@cloudflare/fake-model";

const model = new ModelControl("https://fake-model.example.workers.dev");
await model.configure("test-1", {
  pauses: [{ id: "t2.s0.b1.text.start" }]
});
// …point the agent at model.baseUrl("test-1") and send "[t2] Record alpha."…
await model.release("test-1", "t2.s0.b1.text.start");
const { requests, tools } = await model.state("test-1");
```

`headers` in its options adds headers per request, such as Access
credentials.

## Deploying

```sh
pnpm deploy                               # Worker "fake-model"
FAKE_MODEL_NAME=my-model pnpm deploy      # another name
pnpm dev                                  # locally
```

Reachability is up to the account: a `workers.dev` route behind Access needs
Access credentials, or a service binding from Workers on the same account.
