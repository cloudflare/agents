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
    }
  | { status: "paused"; executionId: string; pending: PendingAction[] }
  | { status: "error"; executionId: string; error: string; logs?: string[] };

type PendingAction = {
  executionId: string;
  seq: number;
  connector: string;
  method: string;
  args: unknown;
};
```

## Resolving approvals

The agent drives resolution through the runtime handle:

```ts
const runtime = createCodemodeRuntime({ ctx: this.ctx, connectors, executor });

// List actions awaiting approval, for approval UIs. With no executionId this
// aggregates across every paused run, so concurrent approvals all show up.
await runtime.pending();

// Approve the pending action(s) and continue
await runtime.approve({ executionId });

// Reject — ends the execution. Does NOT undo actions already applied earlier
// in the same run; call rollback() for that.
await runtime.reject({ seq, executionId });

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
