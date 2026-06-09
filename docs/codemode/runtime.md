# Runtime

The **Executor** is a simple, stateless sandbox: it runs a block of code once and dispatches tool calls back. The **Runtime** wraps an executor and makes execution durable.

The public runtime handle owns the executor and connectors for the current request. `CodemodeRuntime` is the DurableObject facet behind that handle. It owns the durable state: the tool-call log, pending approvals, and snippets.

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

1. **Observation** (read-only) → executes, result recorded in the log.
2. **Approval-required action** → recorded as `pending`, and the run **aborts**.
3. On **continue** → the same code re-runs. Every call already in the log is served from it (a noop replay — observations return their recorded result, applied actions return theirs). The newly-approved action executes for real. The run proceeds to the next pause or to completion.

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

Replay only works if the code is **deterministic up to tool calls**. The Nth tool call on run 1 must be the Nth tool call on run 2. If the code branches on `Math.random()` or `Date.now()` in a way that changes which tools it calls, replay diverges and the runtime throws:

```
Codemode replay divergence at step 2: expected github.create_issue,
got github.merge_pull_request. Code must be deterministic up to tool calls.
```

In practice, model-generated code is naturally deterministic — it fetches data, branches on the data (which is replayed identically), and calls tools. The constraint only bites if code uses nondeterministic sources to drive control flow.

## The tool-call log

```ts
type ToolLogEntry = {
  seq: number;
  connector: string;
  method: string;
  args: unknown;
  result?: unknown; // recorded for replay
  requiresApproval: boolean;
  description?: string;
  state: "applied" | "pending" | "reverted";
};
```

## Lifecycle

```ts
const runtime = createCodemodeRuntime({ ctx, executor, connectors });

// expose the model-facing tool
tools: {
  codemode: runtime.tool();
}

// list actions awaiting approval
const pending = await runtime.pending();

// approve + continue (re-runs via replay)
await runtime.approve({ executionId });

// reject a pending action (ends the execution)
await runtime.reject({ seq });

// rollback applied actions in reverse order
await runtime.rollback();
```

## Rollback

Rollback walks the log backward and calls `revertAction` on each applied action's connector:

```ts
class GithubConnector extends McpConnector<Env> {
  async revertAction(method: string, args: unknown, result: unknown) {
    if (method === "create_issue") {
      const { number } = result as { number: number };
      await this.closeIssue(number);
    }
  }
}
```

Connectors that don't implement `revertAction` are skipped (the user is told the action can't be auto-reverted). Observations are never reverted.

## Snippets

The runtime also stores [snippets](./snippets.md) — durable, addressable scripts the model saves with `codemode.save(name)` and re-runs with `codemode.run(name)`. They live here because the runtime is the natural home for learned, accumulated state (unlike the executor and connectors, which are transient).

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
await runtime.reject({ seq });
await runtime.rollback();
```

## Why a facet

The runtime is a DurableObject facet of the agent because:

- The log, snippets, and state must survive hibernation — approvals can take minutes or hours.
- The facet is durable; the executor and connector stubs are transient and re-provided per message.
- One runtime facet per connector set owns the whole execution lifecycle.
