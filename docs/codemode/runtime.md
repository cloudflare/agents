# Runtime

The **Executor** is a simple, stateless sandbox: it runs a block of code once and dispatches tool calls back. The **Runtime** wraps an executor and makes execution durable.

**Why this exists:** approvals can take minutes or hours, and agents hibernate. A model may write a script that reads data, asks to create an issue, and continues after the user approves — possibly in a different request, after the Durable Object restarted. That needs durable state, which cannot live in the executor or in a single request. The runtime is where it lives.

The public runtime handle owns the executor and connectors for the current request. `CodemodeRuntime` is the DurableObject facet behind that handle. It owns the durable state: the tool-call log, pending approvals, and snippets.

## Configure

```ts
import {
  createCodemodeRuntime,
  DynamicWorkerExecutor
} from "@cloudflare/codemode";

const runtime = createCodemodeRuntime({
  ctx: this.ctx, // the agent's DurableObjectState
  executor: new DynamicWorkerExecutor({ loader: this.env.LOADER }),
  connectors: [github, repoApi]
});
```

| Handle method                                        | Purpose                                                                           |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| `runtime.tool(options?)`                             | The single model-facing AI SDK tool, `codemode({ code })`                         |
| `runtime.pending(executionId?)`                      | Actions awaiting approval — drives approval UIs; no id aggregates all paused runs |
| `runtime.approve({ executionId })`                   | Approve the pending action and continue via replay                                |
| `runtime.reject({ seq, executionId })`               | Reject a pending action; ends the execution                                       |
| `runtime.rollback({ executionId })`                  | Revert applied actions in reverse order via each tool's `revert`                  |
| `runtime.executions(limit?)`                         | All executions, newest first — the audit trail for developer UIs                  |
| `runtime.deleteExecution(id)` / `pruneExecutions(n)` | Drop one execution / keep only the newest N terminal ones                         |
| `runtime.saveSnippet(name, opts?)`                   | Promote an execution's script to a reusable [snippet](./snippets.md)              |
| `runtime.snippets()` / `runtime.deleteSnippet(name)` | List / remove saved snippets                                                      |

## The sandbox API (`codemode.*`)

The runtime also provides the model's API. Inside the sandbox, `codemode` is a global with four methods — discover, learn, do-once, reuse:

| Sandbox method               | Purpose                                                                  |
| ---------------------------- | ------------------------------------------------------------------------ |
| `codemode.search(query)`     | Ranked search across connector methods and saved snippets                |
| `codemode.describe(target)`  | TypeScript docs for a connector, method, or snippet — fetched on demand  |
| `codemode.step(name, fn)`    | Run a side-effectful or nondeterministic closure once; replay its result |
| `codemode.run(name, input?)` | Run a [snippet](./snippets.md) the developer saved                       |

Connector methods appear next to it as their own globals (`github.list_pull_requests(...)`).

**Why discovery lives in the sandbox:** the alternative is generating types for every tool and putting them all in the tool description, which floods the context as the tool count grows. `search` and `describe` return results **into the running code**, not into the prompt — the model pays for exactly the type information it asks for.

```ts
const matches = await codemode.search("pull request");
// { results: [{ path: "github.list_pull_requests", kind: "method", score: 145 }, ...], total, truncated }

const docs = await codemode.describe("github.list_pull_requests");
// { path, description, types: "type ListPullRequestsInput = { owner: string; ... }", kind: "method" }
```

`describe` works on a connector (`"github"`), a method (`"github.list_pull_requests"`), or a snippet name. Search ranks with executor-style matching: names are normalized (`camelCase`/`snake_case`/dots split into tokens), fields are scored by weight (path 12, method 10, connector 8, description 5) with bonuses for exact/prefix/phrase matches, and results are capped at 50 — when `truncated` is true the model should search again with a more specific query.

`codemode.step` is the explicit side-effect boundary that makes [abort-and-replay](#abort-and-replay) correct: the closure runs inside the sandbox, the result is recorded in the log, and on replay the closure is skipped.

```ts
const id = await codemode.step("gen-id", () => crypto.randomUUID());
const data = await codemode.step("fetch", async () =>
  (await fetch(url)).json()
);
```

## Executor vs Runtime

|          | Executor                                         | Runtime                                  |
| -------- | ------------------------------------------------ | ---------------------------------------- |
| What     | Code sandbox                                     | Durable execution engine                 |
| Lifetime | One `execute()` call                             | Whole conversation (DO facet)            |
| State    | None                                             | Tool-call log, pending actions, snippets |
| Examples | `DynamicWorkerExecutor`, `IframeSandboxExecutor` | `CodemodeRuntime`                        |

The executor runs code. The runtime wraps the executor and adds durability, approvals, rollback, and state.

## Abort and replay

The core mechanism. When the model's code runs, every tool call is recorded in a durable log:

1. **Read** (no annotation) → executes, result recorded in the log.
2. **Approval-required action** → recorded as `pending`, and the run **aborts**.
3. On **continue** → the same code re-runs. Every call already in the log is served from it (a noop replay — reads return their recorded result, applied actions return theirs). The newly-approved action executes for real. The run proceeds to the next pause or to completion.

```
run 1:  search() ──exec──> "results"        [logged: applied]
        list_prs() ──exec──> [pr1, pr2]      [logged: applied]
        create_issue() ──PAUSE──             [logged: pending]
        ✗ run aborts

user approves

run 2:  search() ──replay──> "results"       (from log, no re-exec)
        list_prs() ──replay──> [pr1, pr2]     (from log, no re-exec)
        create_issue() ──exec──> { number }   (approved, runs for real)
        post_comment() ──exec──> ok            (continues)
        ✓ run completes
```

The log is the replay spine. Everything — replay, rollback, audit — reads off it.

## Determinism requirement

Replay only works if the code is **deterministic up to tool calls**. The Nth tool call on run 1 must be the Nth tool call on run 2, with the same arguments. If the code branches on `Math.random()` or `Date.now()` in a way that changes which tools it calls — or passes nondeterministic values as arguments to an approval-gated action — replay diverges. The runtime detects this (the connector/method differs, or the stably-stringified arguments differ from the recorded call), records the execution as failed, and the tool returns an error result rather than throwing:

```ts
{
  status: "error",
  executionId: "exec_...",
  error: "Codemode replay divergence at step 2: arguments changed since the original run. Wrap nondeterministic work in codemode.step()."
}
```

Returning the divergence as data (instead of throwing across the RPC boundary) keeps the agent loop intact and lets the model self-correct. To make nondeterministic work replay-safe, wrap it in `codemode.step(name, fn)` so the value is captured once and replayed identically.

In practice, model-generated code is naturally deterministic — it fetches data, branches on the data (which is replayed identically), and calls tools. The constraint only bites if code uses nondeterministic sources to drive control flow or build action arguments.

**Issue tool calls sequentially.** The replay cursor assigns each call its sequence number when the call reaches the host, so `await a(); await b();` is stable across runs but `await Promise.all([a(), b()])` is not — the two calls can arrive in either order. On a run that never pauses this is harmless, but if such a run later pauses and resumes, the reordered calls trip divergence detection. Await connector calls one at a time in any run that might pause for approval.

## The tool-call log

```ts
type ToolLogEntry = {
  seq: number;
  connector: string;
  method: string;
  args: unknown;
  result?: unknown; // recorded for replay
  requiresApproval: boolean;
  state: "executing" | "applied" | "pending" | "reverted";
};
```

A call is logged `executing` the moment the runtime decides to run it, and only flips to `applied` once its result is recorded. So a crash between those two points replays as a fresh execution (re-run) rather than replaying a missing result. Once a run pauses or terminates, every further call/step gets a pause decision and records nothing — model code that catches the pause and keeps going cannot apply extra effects.

## Rollback

Rollback walks the log backward and calls the `revert` of **every** applied action that has one — independent of `requiresApproval`. A non-approval write with a `revert` is still undone; an approval-gated action without a `revert` is not. `revert` (via `revertAction`) returns whether it actually reverted, and the runtime marks only those entries `reverted`:

```ts
protected tool(name: string, t: ConnectorTool): ConnectorTool {
  if (name === "create_issue") {
    return {
      ...t,
      requiresApproval: true,
      revert: async (_args, result) => {
        const { number } = result as { number: number };
        await this.closeIssue(number);
      }
    };
  }
  return t;
}
```

Tools without a `revert` are skipped (the user is told the action can't be auto-reverted). Reads are never reverted. `reject()` does **not** roll back — it only ends a paused execution (marking it `rejected`); call `rollback()` to undo actions already applied earlier in the run. Rollback attempts every revert even if one throws (failures are reported afterward rather than aborting the rest), and marks the execution `rolled_back` so the audit trail reflects that its effects were undone.

A terminal execution is one of `completed`, `error` (a thrown sandbox error or replay divergence), `rejected`, or `rolled_back`. These are exactly the statuses a connector's [`disposeExecution`](./connectors.md#per-execution-resources) hook fires for; `running` and `paused` are not terminal.

## Retention

The execution log is the audit trail, so it grows with every run. Terminal executions (completed or errored) are **auto-pruned** as new runs begin, keeping the newest `maxExecutions` (default 50). Running and paused executions are never pruned — an awaiting-approval run is always resumable.

```ts
const runtime = createCodemodeRuntime({
  ctx,
  executor,
  connectors,
  maxExecutions: 50 // cap on retained terminal executions
});

// Explicit controls
await runtime.executions(20); // newest first, optionally limited
await runtime.deleteExecution(id); // drop one (returns whether it existed)
await runtime.pruneExecutions(10); // keep only the newest N terminal runs
```

## Shaping results

A run's final result can be large enough to crowd the model's context. Pass `transformResult` to reshape the **model-facing** result of a completed run — most often to truncate it. It runs after the raw result is recorded, so the audit trail (`runtime.executions()`) keeps the full value while the model sees the shaped one. It applies on both the initial run and a resume after approval.

```ts
import { createCodemodeRuntime, truncateResult } from "@cloudflare/codemode";

const runtime = createCodemodeRuntime({
  ctx,
  executor,
  connectors,
  // Cap response size; small structured results pass through unchanged.
  transformResult: (result) => truncateResult(result)
});
```

`truncateResult(value, options?)` returns the value unchanged when its serialized size is within budget, and a truncated string (with a marker noting the original size) when it isn't. `truncateResponse(text, options?)` is the string-only variant. Both take `{ maxChars?, maxTokens? }` (default ~6000 tokens).

`transformResult` shapes only the final returned value — individual connector results inside the run are unaffected, so the model's own code still sees full data to reason over.

## Snippets

The runtime also stores [snippets](./snippets.md) — durable, addressable scripts the developer promotes with `runtime.saveSnippet(name)` and the model re-runs with `codemode.run(name)`. They live here because the runtime is the natural home for accumulated state (unlike the executor and connectors, which are transient).

## Runtime identity

The runtime facet's identity is **derived from the connector set** it was created with — the facet name is a fingerprint of the connector names. This is deliberate and load-bearing:

- A snippet references connectors as globals (`github.list_pull_requests(...)`), so it is only valid against the connectors that were present when it was saved.
- Because the runtime is keyed by its connector set, a snippet can only ever be stored in, and run from, a runtime that has those connectors.
- Change the connector set — add, remove, or rename a connector — and you address a **different** runtime, with its own snippets and executions.

So snippet validity is **structural**: a snippet is always run against exactly the connectors it was written with. No per-snippet dependency tracking, no orphaned references, no validation. The same applies to paused executions — a paused run can only resume against the connector set it started with.

The runtime handle keeps the same `ctx`, `executor`, and `connectors` together, so lifecycle calls address the same durable facet:

```ts
const runtime = createCodemodeRuntime({ ctx, executor, connectors });
await runtime.pending();
await runtime.approve({ executionId });
await runtime.reject({ seq, executionId });
await runtime.rollback({ executionId });
```

## Why a facet

The runtime is a DurableObject facet of the agent because:

- The log, snippets, and state must survive hibernation — approvals can take minutes or hours.
- The facet is durable; the executor and connector stubs are transient and re-provided per message.
- One runtime facet per connector set owns the whole execution lifecycle.
