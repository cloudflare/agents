# Approvals

Connectors annotate methods that require user approval. When the model's code calls one, the run **pauses** (aborts), the action is recorded as pending, and the user is asked to approve. On approval the execution **continues via replay** — see [Runtime](./runtime.md) for the mechanism.

## Annotations

```ts
class GithubConnector extends McpConnector<Env> {
  annotations() {
    return {
      // Read-only — executes immediately, result recorded
      list_pull_requests: { observation: true },
      search_issues: { observation: true },

      // Needs approval — pauses the run
      create_issue: {
        requiresApproval: true,
        approvalDescription: "Create a new GitHub issue"
      },
      merge_pull_request: {
        requiresApproval: true,
        approvalDescription: "Merge a pull request"
      }
    };
  }
}
```

| Field                 | Type      | Purpose                           |
| --------------------- | --------- | --------------------------------- |
| `observation`         | `boolean` | Read-only. No side effects.       |
| `requiresApproval`    | `boolean` | Pauses the run for user approval. |
| `approvalDescription` | `string`  | Shown in the approval UI.         |

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

```ts
type ProxyToolOutput =
  | { status: "completed"; result: unknown; logs?: string[] }
  | { status: "paused"; executionId: string; pending: PendingAction[] };

type PendingAction = {
  executionId: string;
  seq: number;
  connector: string;
  method: string;
  args: unknown;
  description?: string;
};
```

## Resolving approvals

The agent drives resolution through the runtime handle:

```ts
const runtime = createCodemodeRuntime({ ctx: this.ctx, connectors, executor });

// List actions awaiting approval, for approval UIs
await runtime.pending();

// Approve the pending action(s) and continue
await runtime.approve({ executionId });

// Reject — ends the execution
await runtime.reject({ seq });

// Roll back applied actions in reverse order
await runtime.rollback();
```

Wire these to callable agent methods so the client UI can approve/reject:

```ts
export class Chat extends AIChatAgent<Env> {
  @callable()
  async listPending() {
    return this.codemodeRuntime().pending();
  }

  @callable()
  async approve(executionId?: string) {
    return this.codemodeRuntime().approve({ executionId });
  }
}
```

## Rollback

Rollback reverts applied actions by calling `revertAction` on each connector in reverse order:

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

Connectors without `revertAction` are skipped. Observations are never reverted.

## Comparison with Gatekeeper

| Concept              | Gatekeeper                         | Codemode                              |
| -------------------- | ---------------------------------- | ------------------------------------- |
| Read classification  | `authorizeObservation()`           | `{ observation: true }`               |
| Write classification | `submitAction()`                   | `{ requiresApproval: true }`          |
| Pending state        | Simulated in the session           | Logged; run aborts                    |
| Continue             | Session simulates ahead            | Abort-and-replay                      |
| Apply                | `applyAction(action)`              | `runtime.approve(...)` replays + runs |
| Reject               | `rejectAction(action)`             | `runtime.reject({ seq })`             |
| Revert               | `revertAction(action, revertInfo)` | `revertAction(method, args, result)`  |

The key difference: Gatekeeper _simulates_ pending actions so code keeps running. Codemode _aborts and replays_ — simpler and fully durable, at the cost of re-running the code (cheap, since prior calls are served from the log).
