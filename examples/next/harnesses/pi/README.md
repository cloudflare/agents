# Pi harness

An experimental example that runs pi's durable `AgentHarness` inside a plain
Durable Object, composed from the SDK's Lifecycle capabilities. Nothing here is
exported from the `agents` package yet; `PiHarness` and the Workers AI provider
live in this example's `src/` and use the published pi release.

The example composes:

- `PiHarness extends LifecycleCapability` for the durable agent loop;
- `StateMachine` to give every operation a durable, versioned checkpoint that
  wraps pi's own drive loop as a reconciled effect;
- `Streams` to durably record every operation's live output;
- `WebSockets` to serve that output to the browser;
- `agents/skills` for a bundled `trip-planning` skill;
- pi-ai's Workers AI provider, transported over the `AI` binding.

Pi owns the transcript, tool intents and results, provider retries, and
recovery. The SDK supplies durable wakes, bounded retries for attaching a drive
pass, the output log, and the client transport.

## Why a wrapped runtime, not a native machine

Pi is already a durable state machine. Re-expressing its model and tool phases
as `StateMachine` phases would create two authorities for the same effects, so
this example uses the second integration shape from the state-machine design:
a **durable runtime wrapper**.

Each operation becomes one machine run whose checkpoint holds only the input
for the current drive pass. The phase uses `effects.run()` to commit and execute
the pass without storing an effect handle in user state. The effect uses
`recovery: "reconcile"` and is keyed by pi's own operation id:

```text
drive ──▶ (settled) ──▶ complete
  │
  ├────▶ (attachment retry) ──▶ drive
  │
  └────▶ (pi waiting) ──▶ waiting ──▶ drive …
```

After an eviction the machine does not replay the model request. It asks pi,
through `getResult()` and `inspectExecution()`, what actually happened:

| Pi's record            | Reconciled as | The machine then       |
| ---------------------- | ------------- | ---------------------- |
| terminal result exists | `completed`   | settles the run        |
| operation still live   | `running`     | parks and re-checks    |
| nothing recorded       | `not-found`   | reports it interrupted |

Pi's provider backoffs and deferred-request polls surface as `waiting`, so a
run parks on a durable deadline instead of holding a JavaScript invocation
open. A drive attachment also gets three durable attempts with exponential
backoff. These retries reuse the same effect and operation id, so eviction
during backoff does not repeat completed work.

The drive effect deliberately sets no `timeoutMs`. A pass is turn-sized, so
there is no duration that distinguishes a healthy turn from a stuck one, and
an effect timeout is not a detach: it aborts the effect's signal, which the
drive pass forwards to pi as a durable `requestAbort`. A slow-but-healthy turn
would be cancelled rather than resumed. Nothing is lost by omitting it,
because pi runs `driveOperation` as a floating promise owned by the lane and
the caller only observes it — an invocation that dies mid-pass leaves the
drive intact, and the next pass re-attaches by operation id. A whole-isolate
loss is covered by `recovery: "reconcile"`.

## Run locally

```sh
pnpm install
pnpm run start
```

The example uses the remote Workers AI binding and may incur Workers AI usage.
It needs no API key. If your Wrangler login has access to more than one
account, set `CLOUDFLARE_ACCOUNT_ID` when starting.

## What to try

- `Roll four 12-sided dice and total them.`
- `Use the calculator to multiply 47 by 19.`
- `Remember that my favourite launch snack is stroopwafels.`
- `What did I tell you my favourite launch snack was?`
- `I want to plan a trip.` activates the bundled skill.

Tool calls and results render live as they happen. Reload the page mid-turn
and the transcript and in-flight reply resume from the durable stream. Use the
new-session button to start with a fresh Durable Object.

## Test

```sh
pnpm test
```

The test runs a real Durable Object with pi-ai's faux provider, drives a tool
call to settlement, evicts the object, and checks the transcript and a second
turn survive.

## Core pattern

```ts
export class PiAgent extends DurableObject<Env> {
  readonly streams = new Streams();

  readonly harness = new PiHarness({
    models: createModels({ providers: [workersAI(this.env.AI)] }),
    model: { provider: "cloudflare-workers-ai", modelId: MODEL_ID },
    streams: this.streams,
    tools: () => tools
  });

  readonly webSockets = new WebSockets(this.harness.webSockets());

  readonly lifecycle = Lifecycle.install(this)
    .use(this.streams)
    .use(this.harness.stateMachine)
    .use(this.webSockets)
    .use(this.harness);
}
```

`PiHarness` owns its `StateMachine` rather than receiving one, because the
machine definition and its effect runtime are bound to that harness's pi
attachment; install it on the same Lifecycle with `.use(harness.stateMachine)`.

Each operation runs as one machine run that drives pi to settlement. Every
operation's events land in one `Streams` stream, and `harness.webSockets()`
returns the options for a `WebSockets` capability that serves a small JSON
protocol: a lane snapshot on connect, `subscribe` to replay-then-tail an
operation's stream from a client cursor, and `submit`, `abort`, and `steer` to
drive it. The browser connects with `useAgent` from `agents/react`;
`src/use-pi-session.ts` layers the protocol on that socket.

### Admission and cancellation

`submit()` writes a row to a small intake table _before_ it starts the machine
run, so a crash between the two is repaired on the next wake: startup re-runs
`StateMachine.run()` for every queued submission, and `run()` is idempotent on
the operation id. Cancellation is durable on both sides — pi records its own
abort marker and the machine run is cancelled, so no further pass is admitted.

### Steering and interrupting

`steer()` queues a message for the running operation, and `followUp()` queues
one for after it: pi claims a follow-up at a boundary only when no steer is
waiting there. Neither waits for the end of a turn, because pi reaches a
boundary after every tool batch as well as after every assistant message.

`steer(message, { urgency: "interrupt" })` is for a correction that must not
wait at all. It aborts the operation, which stops the current request through
pi's durable cancel marker, and the message becomes the prompt of a
replacement operation. Aborting drains the entire lane inbox, including
messages other callers queued and were given receipts for, so the harness
re-queues those onto the replacement — each as its own entry, with its kind
and structure intact — rather than discarding them or flattening them into one
prompt. What is genuinely lost is the assistant output that was mid-stream,
and the cancelled operation settles as cancelled.

## Pi source

The example depends on pi's published packages from npm; nothing is vendored.
Pi is MIT licensed; see
[`licenses/mit-earendil-pi.txt`](./licenses/mit-earendil-pi.txt). The design
and the work left before this can become a package export are in
[`design/rfc-pi-harness-example.md`](../../../design/rfc-pi-harness-example.md).

One resolution note: the published sqlite session backend exports only its
root entry, and that entry imports `node:sqlite`, which Workers does not
provide. The harness needs only `SqliteStorage`, which has no Node dependency,
so `vite.config.ts` aliases that single module out of the package's `dist` and
`tsconfig.json` mirrors the mapping for types.
