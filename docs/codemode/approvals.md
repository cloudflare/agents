# Approvals

A tool with `requiresApproval: true` pauses the run when the model's code calls it (the run aborts), the action is recorded as pending, and the user is asked to approve. On approval the execution **continues via replay** — see [Runtime](./runtime.md) for the mechanism.

## Marking tools

On a custom connector, set it on the tool itself:

```ts
protected tools() {
  return {
    create_issue: {
      description: "Create a GitHub issue.",
      requiresApproval: true,
      execute: (args) => this.client.createIssue(args)
    }
  };
}
```

On a derived connector (MCP, OpenAPI), decorate via the `tool(name, t)` hook:

```ts
class GithubConnector extends McpConnector<Env> {
  protected tool(name: string, t: ConnectorTool): ConnectorTool {
    if (name === "create_issue" || name === "merge_pull_request") {
      return { ...t, requiresApproval: true };
    }
    return t;
  }
}
```

`requiresApproval: true` is the entire surface. Mark only what needs a human — everything else executes immediately and is still recorded in the durable log for replay and audit.

## Flow

```
Model calls codemode({ code }) where code calls github.create_issue(...)
  → runtime logs calls; create_issue requires approval → run pauses
  → tool returns { status: "paused", executionId, pending: [...] }

Agent shows the pending action to the user.
User approves.

Agent calls runtime.approve({ executionId })
  → runtime replays the log, runs create_issue for real, continues
  → returns { status: "completed", result } (or pauses again at the next action)
```

The model writes code as if the call returns normally. It doesn't see a provisional result — the run simply pauses and resumes transparently across the approval.

## Tool output

Execution outcomes are returned, not thrown — a sandbox error or a replay divergence comes back as `{ status: "error" }` (and is recorded on the execution), so the agent loop is never broken by an exception:

```ts
type ProxyToolOutput =
  | {
      status: "completed";
      executionId: string;
      result: unknown;
      logs?: string[];
      calls?: ToolLogEntry[];
    }
  | {
      status: "paused";
      executionId: string;
      pending: PendingAction[];
      calls?: ToolLogEntry[];
    }
  | {
      status: "error";
      executionId: string;
      error: string;
      logs?: string[];
      calls?: ToolLogEntry[];
    };

type PendingAction = {
  executionId: string;
  seq: number;
  connector: string;
  method: string;
  args: unknown;
  resolution?: "approval" | "client";
};
```

Every outcome also carries `calls` — the execution's [tool-call log](./runtime.md#the-tool-call-log) as it stands at the end of the pass: each connector call and `codemode.step`, with args, recorded result, approval requirement, and state. Render it to show the user what a run actually did (and what is still pending) without a separate `executions()` round trip.

`resolution` tells the UI what kind of answer the pending action needs: `"approval"` (the default) is a yes/no — approve and the host executes the tool server-side; `"client"` means the tool never executes server-side and the run stays paused until the host supplies the tool's result via `resolve()` — see [Client-resolved tools](#client-resolved-tools).

## Resolving approvals

The agent drives resolution through the runtime handle:

```ts
const runtime = createCodemodeRuntime({ ctx: this.ctx, connectors, executor });

// List actions awaiting approval, for approval UIs. With no executionId this
// aggregates across every paused run, so concurrent approvals all show up.
await runtime.pending();

// Approve the pending action(s) and continue
await runtime.approve({ executionId });

// Supply a client-resolved call's result and continue — for pending actions
// with resolution: "client" (see below); approve() cannot satisfy these.
await runtime.resolve({ executionId, seq, result });

// Reject — ends the execution. Does NOT undo actions already applied earlier
// in the same run; call rollback() for that. Returns false if the action was
// no longer pending (approved/rejected elsewhere) — check it before telling
// the user the run was rejected, because the action may have executed.
const terminated = await runtime.reject({ seq, executionId });

// Roll back applied actions in reverse order
await runtime.rollback({ executionId });
```

Every lifecycle call targets an explicit `executionId` (there is no implicit "current run" — that would be racy when multiple runs are in flight). Get the id from `pending()`, from `executions()`, or from the tool's own output, which carries `executionId` on every outcome.

`approve()` is a **safe no-op on a run that is no longer paused.** Approval UIs are racy: the run may have completed, been rejected, or been rolled back — in another tab, by another operator, or by a concurrent turn — between the moment the queue was rendered and the moment someone clicks. In that case `approve()` does not revive the run (which would re-offer a rejected action or re-apply rolled-back effects); it returns `{ status: "error", executionId, error: "...is not paused..." }` and changes nothing. Treat that outcome as "this run already moved on, refresh the queue," not as an execution failure. Only a `paused` run can be resumed.

Wire these to callable agent methods so the client UI can approve/reject:

```ts
export class Chat extends AIChatAgent<Env> {
  @callable()
  async listPending() {
    return this.codemodeRuntime().pending();
  }

  @callable()
  async approve(executionId: string) {
    return this.codemodeRuntime().approve({ executionId });
  }
}
```

## Client-resolved tools

Some tools can't execute server-side at all — their result comes from the client (a browser API like `getUserTimezone`, an `ask_user` prompt, a device sensor). Mark them `resolution: "client"`: calling one pauses the run durably, exactly like an approval, but instead of approving you **supply the result**:

```ts
protected tools() {
  return {
    get_user_timezone: {
      description: "The user's IANA timezone, read from the browser.",
      requiresApproval: true,
      resolution: "client",
      execute: () => {
        throw new Error("client-resolved — supplied via resolve()");
      }
    }
  };
}
```

For an AI SDK `ToolSet` wrapped in a `ToolSetConnector`, execute-less tools are skipped by default (advertising a method the sandbox can't call would send the model down a dead end). Opt them in instead with `clientTools: "pause"` — they're then exposed in the sandbox and the generated types as client-resolved tools:

```ts
new ToolSetConnector(ctx, { name: "tools", tools, clientTools: "pause" });
```

The flow mirrors approvals, with `resolve()` in place of `approve()`:

```
Model code calls tools.get_user_timezone()
  → run pauses; pending action carries resolution: "client"
  → agent surfaces it to the client (same channel as approvals)
  → client computes the value and calls back
  → runtime.resolve({ executionId, seq, result: "Europe/London" })
  → the result is recorded as the call's value; the run replays and continues —
    the model's code sees it as the call's ordinary return value
```

`approve()` can never satisfy a client-resolved call — on such a run it just returns the same `paused` outcome again. `resolve()` has the same safety properties as `reject()`: it only lands on an action that is still pending on a paused run, and a stale/duplicate resolve returns an error outcome rather than throwing or double-applying. A client that never answers is covered by [`expirePaused`](./runtime.md#retention), same as an approval nobody answers.

The client-supplied result is recorded in the durable log and replayed as ground truth — it is **trusted**. Validate it at the agent boundary (the `@callable` method) if the client isn't.

## Rollback

Rollback reverts **all** applied actions that have a `revert` — not only approval-gated ones — in reverse order. Define `revert` on the tool (or override `revertAction`); it returns whether a revert actually ran, and the runtime marks only those entries as reverted:

```ts
protected tools() {
  return {
    create_issue: {
      description: "Create a GitHub issue.",
      requiresApproval: true,
      execute: (args) => this.client.createIssue(args),
      revert: (_args, result) => {
        const { number } = result as { number: number };
        return this.client.closeIssue(number);
      }
    }
  };
}
```

Tools without a `revert` are skipped, as are reads. Rollback is independent of approval: a non-approval write with a `revert` is still undone.

## Comparison with Gatekeeper

| Concept              | Gatekeeper                         | Codemode                                          |
| -------------------- | ---------------------------------- | ------------------------------------------------- |
| Read classification  | `authorizeObservation()`           | unannotated (default)                             |
| Write classification | `submitAction()`                   | `{ requiresApproval: true }`                      |
| Pending state        | Simulated in the session           | Logged; run aborts                                |
| Continue             | Session simulates ahead            | Abort-and-replay                                  |
| Apply                | `applyAction(action)`              | `runtime.approve({ executionId })` replays + runs |
| Reject               | `rejectAction(action)`             | `runtime.reject({ seq, executionId })`            |
| Revert               | `revertAction(action, revertInfo)` | `revertAction(method, args, result)`              |

The key difference: Gatekeeper _simulates_ pending actions so code keeps running. Codemode _aborts and replays_ — simpler and fully durable, at the cost of re-running the code (cheap, since prior calls are served from the log).
