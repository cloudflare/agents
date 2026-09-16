# Shared harness capability

`@cloudflare/agents-next-harness` is the one `Harness` capability every harness
example under `examples/next/harnesses` composes. It is example-local on
purpose: nothing here is exported from the `agents` package yet. The design is
`design/rfc-harness-capability.md`.

One developer API, whatever runs the loop:

```ts
const session = this.harness.session(); // a handle: no await, no I/O
const { operationId } = await session.prompt("Refactor the parser"); // durable before it resolves
for await (const event of session.events({ previews: true })) {
  if ("preview" in event) render.delta(event.body);
  else if (event.body.type === "request_raised") render.ask(event.body.request);
  else if (event.body.type === "operation_settled") break;
}
await session.reply(requestId, { type: "permission", decision: "allow" });
const result = await session.wait(operationId);
```

Harnesses differ by runtime, never by subclass:

```ts
readonly harness = new Harness({
  tasks: this.tasks,
  streams: this.streams,
  runtime: new PiRuntime({ ... }) // or CodexRuntime, SelfModifyingRuntime, ContainerHarnessRuntime
});
readonly webSockets = new WebSockets(this.harness.webSockets());
```

## What the base owns

- **Admission.** `prompt()`, `submit()`, `compact()`, `interrupt()` and
  `reply()` are one row write into a durable inbox. Operation ids are
  idempotency keys; a replayed id returns `accepted: false`, a conflicting
  input throws.
- **Operations and requests.** One row per operation, inserted at admission
  and updated once at settlement. Open requests are rows until answered, timed
  out (the base writes the deny itself) or lost.
- **Logs.** One Streams log per operation plus one per session. Frames carry a
  session-monotonic `seq`; the cursor a client passes around is that seq.
  Appends are batched (100 ms / 64 frames / 256 KiB) into one row write.
  Token deltas are previews: live-only, never persisted.
- **The driver.** One Tasks run per session, registered under a reserved
  `__cf_harness@v1:<id>` definition. It calls `runtime.drive(ctx)` until the
  inbox is empty, re-checks the inbox before it exits, rotates after 4000
  passes, backs off on errors and declines an input the runtime fails on five
  times.
- **The browser link.** `webSockets()` returns options for the `WebSockets`
  capability: snapshot in, replay-then-tail event batches out, method calls by
  id. `useHarnessSession()` in `./react` consumes it.

## What a runtime owns

`HarnessRuntime.drive(ctx)` reads the inbox, calls `ctx.begin()`, appends
frames and previews to the operation handle, asks with `ctx.ask()` or
`ctx.requests.open()`, and calls `ctx.settle()`. `messages()` serves the
transcript from wherever the runtime keeps it. Optional hooks add `fork`,
`rewind`, `configure`, `cancelQueued`, `close`, `delete` and `usage`; each is
advertised through `capabilities` and gated on `status().capabilities`.

Runtime-specific events, submissions and results ride a `HarnessProtocol`
type parameter: events as `{ type: "extension", body }`, submissions through
`submit()`, the terminal record as `result.raw`.

## Entry points

| Import                                     | Contents                                                           |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `@cloudflare/agents-next-harness`          | `Harness`, every type, the errors                                  |
| `@cloudflare/agents-next-harness/protocol` | Wire contracts, zero dependencies; the daemon imports this         |
| `@cloudflare/agents-next-harness/react`    | `useHarnessSession()`                                              |
| `@cloudflare/agents-next-harness/remote`   | `ContainerHarnessRuntime`: a runtime in a Container over Cap'n Web |

## Tests

```sh
pnpm test
```

The suite drives a real Durable Object with an echo runtime through the whole
API: admission, replay from any cursor, live tails with previews, idempotent
ids, interrupt with drain, a request round trip, request timeout, runtime
submissions, multiple sessions, eviction between operations and eviction in
the middle of one; a second suite drives `ContainerHarnessRuntime` against an
in-isolate fake daemon over a `WebSocketPair`.

## Driving a deployed example from a terminal

`scripts/drive.mjs` speaks the browser wire with Node's built-in WebSocket:
it connects, takes a snapshot, subscribes from the page cursor, sends one
prompt, answers every request the agent raises, prints the log and exits when
the operation settles.

```sh
node scripts/drive.mjs https://pi-harness-example.<subdomain>.workers.dev pi-agent my-session "Roll 4d12"
node scripts/drive.mjs https://codex-harness-example.<subdomain>.workers.dev coder my-session "Write a haiku to the demo file"
node scripts/drive.mjs <base-url> <agent> <name> "<prompt>" [--deny] [--session id] [--timeout seconds]
node scripts/drive.mjs <base-url> <agent> <name> "slow task" --interrupt-after 2   # interrupt mid-turn
node scripts/drive.mjs <base-url> <agent> <name> "slow task" --detach             # prompt, then leave; reconnect later to replay
node scripts/drive.mjs <base-url> <agent> <name> x --replay                        # no prompt: print the whole durable log
node scripts/drive.mjs <base-url> <agent> <name> "hi" --header "cf-access-token: $(cloudflared access token -app=<base-url>)"
```
