---
title: Think harness (Experimental)
pcx_content_type: reference
description: Run Think's agent loop in a Durable Object with the experimental ThinkHarness lifecycle capability. Transcripts in Sessions, in-flight output in Streams, and turns that survive eviction.
---

`ThinkHarness` runs Think's agent loop as a Lifecycle capability. It has the same shape as the [Pi harness](./pi.md): `harness.prompt()`, `harness.sessions` and `harness.session(id)`. The engine is the AI SDK, and storage uses the Agents SDK's own capabilities:

- The `Sessions` capability keeps each session's transcript as AI SDK `UIMessage`s.
- The `Streams` capability keeps the output of a model call while it streams.
- One Lifecycle job per session wakes the object after an eviction.

It is experimental. The API may change in any release.

## Create the harness

Install `Sessions` and `Streams` on the Lifecycle before the harness:

```ts
import { DurableObject } from "cloudflare:workers";
import { tool } from "ai";
import { z } from "zod";
import { createChatStreams } from "agents/chat";
import { ThinkHarness } from "agents/harness/think";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/ai-sdk";
import { Sessions } from "agents/sessions";

export class Assistant extends DurableObject<Env> {
  ai = createAI({ binding: this.env.AI });
  sessions = new Sessions();
  streams = createChatStreams();

  harness = new ThinkHarness({
    sessions: this.sessions,
    streams: this.streams,
    model: this.ai("@cf/moonshotai/kimi-k2.7-code"),
    system: "You are a helpful assistant.",
    tools: {
      weather: tool({
        description: "Get the weather for a city",
        inputSchema: z.object({ city: z.string() }),
        execute: async ({ city }) => `Sunny in ${city}`
      })
    }
  });

  lifecycle = Lifecycle.install(this)
    .use(this.sessions)
    .use(this.streams)
    .use(this.harness);

  async ask(prompt: string) {
    const result = await this.harness.prompt(prompt);
    return result.status === "done" ? result.text : result.reason;
  }
}
```

On an `Agent`, call `this.lifecycle.use(...)` with the same three capabilities in the constructor.

| Option             | What it is                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions`         | Required. The `Sessions` capability that keeps transcripts.                                                                                     |
| `streams`          | Required. The `Streams` capability that keeps in-flight output. `createChatStreams()` raises the per-chunk ceiling.                             |
| `model`            | Required. An AI SDK `LanguageModel`, or a function of `{ session }` that returns one.                                                           |
| `system`           | The system prompt, or a function of `{ session }`.                                                                                              |
| `tools`            | An AI SDK `ToolSet`, or a function of `{ session }`. Tools with `execute` run on the server. Tools without it run on a client.                  |
| `maxSteps`         | Most model calls one operation makes. Default 10.                                                                                               |
| `toolApproval`     | Decide per call whether a tool needs approval. A tool's own `needsApproval` also applies.                                                       |
| `recovery`         | What to do after an eviction. Refer to [Recovery](#recovery).                                                                                   |
| `configureSession` | Called with each session's `Session` handle the first time the harness uses it. Set compaction here with `onCompaction()` and `compactAfter()`. |
| `hooks`            | Callbacks into the turn loop. Refer to [Hooks](#hooks).                                                                                         |

## Submit and wait

```ts
const session = this.harness.session(); // the root session, id ""

// Durable before the model runs. The same operationId twice returns the same receipt.
const receipt = await session.submit("Summarize the README", {
  operationId: requestId
});
const result = await session.wait(receipt.operationId);

// Or both in one call, with the transcript after it.
const { text, messages } = await session.prompt("Hello");
```

`submit()` accepts a string, a `UIMessage` or an array of them, the shared harness input `{ parts }`, or a tool answer. A submission made while the session is busy waits its turn.

| Method                       | What it does                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| `submit(input, options)`     | Durably queue input. Returns `{ operationId, session, accepted }`.                                       |
| `prompt(input, options)`     | `submit`, then `wait`, then the transcript.                                                              |
| `wait(operationId, signal?)` | Resolve when the operation settles: `done` with `text`, or `unanswered` with a `reason`.                 |
| `inspect(operationId)`       | The operation's status, or `undefined`.                                                                  |
| `chat(input, callback)`      | Stream the answer to `onStart`, `onEvent(json)`, then `onDone` or `onError`, like Think's `chat()`.      |
| `abort(operationId?)`        | Withdraw a queued operation or abort a running one. With no id, everything open in the session.          |
| `regenerate(messageId?)`     | Answer a user message again, as a new branch. `Session.getBranches()` still reads the earlier answers.   |
| `continue()`                 | Call the model again to continue the latest message.                                                     |
| `reset(handoff?)`            | Abort everything and clear the transcript, optionally leaving a system note.                             |
| `messages()`                 | The active transcript.                                                                                   |
| `pending()`                  | Operations not settled yet, oldest first.                                                                |
| `subscribe(listener)`        | Live events in the AI SDK's vocabulary: chunks, persisted messages, operation status, run start and end. |
| `inFlight()`                 | The running operation and its model call's chunks so far, including chunks an eviction left in storage.  |
| `watch()`                    | The shared harness interface's watch, so a Channels host can serve the session.                          |

`harness.sessions` has `create()`, `fork(from)` and `list()`. A fork copies the source session's active path.

## Tools, approvals and client tools

The harness runs every server tool call itself. The model only sees tool definitions, so each model call ends at its tool calls. The harness then runs those calls in parallel and calls the model again with their results. All of this stays in one assistant message.

A call that needs approval is recorded as `approval-requested` and the operation settles. Submit the answer to continue:

```ts
await session.submit({ type: "approval", approvalId, approved: true });
await session.submit({
  type: "tool-result",
  toolCallId,
  result: { ok: true, output: "42" }
});
```

A client tool call works the same way: the operation settles with the call `input-available`, and the client's result continues the turn. Pass `autoContinue: false` with an answer to record it without continuing. Tool schemas a browser sends are kept with the session through `submit(..., { clientTools })`.

## Recovery

Every step of a turn reads only durable state, so a restarted object continues where the last write left off.

- **During a model call.** Chunks are written to a stream as they arrive. When the call ends, the harness persists the message and deletes the stream in one SQLite transaction. After an eviction, the harness rebuilds the partial message from the stream, keeps it, and calls the model again to continue the same message. Tool calls whose input never finished streaming are dropped.
- **During a tool call.** The harness records each call before it runs. After an eviction, a call with a record and no result was cut short. With `recovery.tools[name]: "rerun"` it runs again. With `"report"`, the default, it is recorded as failed with an "interrupted" error and the model decides what to do. Use `rerun` only for tools that are safe to repeat.
- **Budget.** `recovery.maxAttempts` (default 10) counts interruptions without progress. A finished model call or tool call resets the count. Past the budget the operation settles `unanswered` with reason `interrupted`. Retries after the first back off from `recovery.backoffMs` (default 1000), doubling up to a minute.
- **Stalls.** A model stream that sends nothing for `recovery.stallTimeoutMs` (default 120000) is treated as interrupted.
- **Memory limits.** The wake jobs are flagged for the Lifecycle's alarm memory-limit breaker, so a turn that keeps running out of memory is backed off and then stopped.

## Hooks

| Hook             | When                                                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beforeTurn`     | Before every model call. Return `model`, `system`, `messages`, `activeTools`, `toolChoice`, `providerOptions`, `maxOutputTokens` or `temperature`. |
| `beforeToolCall` | Before each server tool call. Return `{ action: "block", reason }`, `{ action: "substitute", output }`, or `{ action: "run", input }`.             |
| `afterToolCall`  | After each server tool call, with its result.                                                                                                      |
| `onStepFinish`   | After each model call's message is persisted.                                                                                                      |
| `onChunk`        | For each UI chunk the model streams.                                                                                                               |
| `onTurnEnd`      | After an operation settles.                                                                                                                        |
| `onError`        | Observe a model call's error.                                                                                                                      |
| `classifyError`  | Return `fail`, `retry`, or `context-overflow`. `classifyContextOverflow` matches the common providers' overflow errors.                            |
| `onRecovery`     | Return `continue` or `abandon` for an interrupted model call.                                                                                      |

`beforeTurn` runs before every model call because a turn makes several, and after an eviction the harness has no memory of what an earlier call returned. On `context-overflow` the harness compacts the session with its compaction function and calls the model again, once.

## Serve useAgentChat

`ThinkChat` speaks Think's chat WebSocket protocol for one session, so `useAgentChat` works unchanged. It also answers `GET …/get-messages`:

```ts
import { ThinkChat } from "agents/harness/think";
import { WebSockets } from "agents/websockets";

webSockets = new WebSockets();
chat = new ThinkChat({ harness: this.harness, webSockets: this.webSockets });

lifecycle = Lifecycle.install(this)
  .use(this.sessions)
  .use(this.streams)
  .use(this.harness)
  .use(this.webSockets)
  .use(this.chat);
```

It handles chat requests (`submit-message` and `regenerate-message`), cancel, clear, client tool results, approvals, and stream resume after a reconnect or an eviction.

## Compared with Think

`ThinkHarness` is meant to replace the engine inside `@cloudflare/think`. It reads and writes the same Sessions and Streams tables, and the root session is Think's conversation. Work in flight when an agent moves over is not carried across.

| Think                                                                      | ThinkHarness                                                |
| -------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `getModel()`, `getSystemPrompt()`, `getTools()`                            | `model`, `system`, `tools` options                          |
| `beforeTurn`, `beforeToolCall`, `afterToolCall`, `onStepFinish`, `onChunk` | Hooks of the same names                                     |
| `beforeStep`                                                               | `beforeTurn`, which runs before every model call            |
| `onChatResponse`, `onChatError`, `classifyChatError`                       | `onTurnEnd`, `onError`, `classifyError`                     |
| `onChatRecovery`, `chatRecovery`                                           | `onRecovery`, `recovery`                                    |
| `submitMessages`, `waitForSubmission`, `inspectSubmission`                 | `submit`, `wait`, `inspect`                                 |
| `saveMessages`, `runTurn`                                                  | `prompt`                                                    |
| `chat(message, callback)`                                                  | `session.chat(input, callback)`                             |
| `cancelChat`, `cancelSubmission`, `cancelAllChats`                         | `abort(operationId)`, `abort()`                             |
| `continueLastTurn`, regeneration                                           | `continue()`, `regenerate()`                                |
| `clearMessages`, `getMessages`, `messages`                                 | `reset()`, `messages()`                                     |
| `configureSession`, compaction                                             | `configureSession`                                          |
| `useAgentChat` protocol                                                    | `ThinkChat`                                                 |
| One conversation per Durable Object                                        | Many sessions per object, with `create`, `fork` and `list`  |
| Tools run inside `streamText`; interrupted calls are repaired              | The harness runs each call, with a recovery policy per tool |

Not supported yet:

- `steer` is accepted but queues like a follow-up. It is meant to join the running turn at its next model call.
- `messageConcurrency` strategies other than queueing (`latest`, `merge`, `drop`, debounce).
- Context blocks from `configureContext()`. Compute the system prompt in `system` or `beforeTurn`.
- Read-time truncation of older tool results and media eviction.
- Workspace tools, `getActions()` with its ledger, agent tools, skills, extensions, MCP tools, messengers, channels policy, scheduled tasks, and workflows. Pass the tools these produce in `tools`; the higher-level features are not ported.
- `listSubmissions` and `deleteSubmissions`. `pending()` lists open operations.
- Client tool ownership by participant, and the `cf_agent_chat_recovering` frame.
- `configure()` and `getConfig()`.
