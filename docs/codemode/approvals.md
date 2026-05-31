# Approvals & Simulation

Connectors can annotate methods as requiring user approval before execution. When the sandbox calls an approval-required method, the session returns a provisional simulated result immediately so code can continue. The real action executes only after the user approves.

## Annotations

Connectors declare annotations per method:

```ts
class GithubConnector extends McpConnector<Env> {
  protected annotations() {
    return {
      // Read-only — executes immediately
      list_pull_requests: { observation: true },
      search_issues: { observation: true },

      // Needs approval — returns provisional result, queues action
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

### Annotation fields

| Field                 | Type      | Purpose                                              |
| --------------------- | --------- | ---------------------------------------------------- |
| `observation`         | `boolean` | Marks a method as read-only. No side effects.        |
| `requiresApproval`    | `boolean` | Method requires user approval before real execution. |
| `approvalDescription` | `string`  | Human-readable description shown in the approval UI. |

Methods with no annotation execute immediately (same as `observation: true`).

## Flow

### Without approval (observation)

```
Sandbox: github.list_pull_requests(args)
  → Session checks annotations → observation: true
  → Session calls connector.executeTool("list_pull_requests", args)
  → Result returns to sandbox immediately
```

### With approval

```
Sandbox: github.create_issue({ title: "Fix bug" })
  → Session checks annotations → requiresApproval: true
  → Session calls connector.simulate("create_issue", args)
  → Session stores pending action in DO storage
  → Session returns provisional result to sandbox
  → Sandbox continues with simulated state

Later:
  → Agent queries codemode.pending()
  → Agent shows to user: "GitHub wants to create an issue. Approve?"
  → User approves
  → Agent calls session.applyAction(actionId)
  → Session calls connector.executeTool("create_issue", args) for real
  → Real result replaces provisional
```

## Simulation

When a method needs approval, the connector's `simulate()` method is called to produce a provisional result. The default returns a pending marker:

```ts
{
  __pending: true,
  provisionalId: "~create_issue_1716825600000",
  method: "create_issue",
}
```

Override `simulate()` on your connector for more realistic provisional results:

```ts
class GithubConnector extends McpConnector<Env> {
  async simulate(method: string, args: unknown) {
    if (method === "create_issue") {
      const { title } = args as { title: string };
      return {
        __pending: true,
        provisionalId: `~issue_${Date.now()}`,
        number: `~${Date.now()}`,
        title,
        state: "open",
        url: `https://github.com/pending/~${Date.now()}`
      };
    }
    return super.simulate(method, args);
  }
}
```

This lets subsequent code reference the provisional issue (e.g., by `number`) while the real issue creation is pending. References like `#~123` can be rewritten to real numbers once the action is applied — matching the Gatekeeper pattern.

## Pending actions

The sandbox can query pending actions via the platform SDK:

```ts
const pending = await codemode.pending();
// [
//   {
//     id: "action_1",
//     connector: "github",
//     method: "create_issue",
//     args: { title: "Fix bug" },
//     description: "Create a new GitHub issue",
//     provisionalResult: { __pending: true, provisionalId: "~issue_1716825600000", ... },
//     createdAt: 1716825600000,
//   },
// ]
```

## Resolving approvals

The agent handles approval resolution. When the user approves or rejects:

```ts
// In the agent — approval from UI
async handleApproval(connector: string, actionId: string, action: "approve" | "reject") {
  const session = this.ctx.facets.get(`codemode:${connector}`);
  if (action === "approve") {
    const result = await session.applyAction(actionId);
    // Real result now available
  } else {
    await session.rejectAction(actionId);
  }
}
```

## Types

```ts
type ToolAnnotations = {
  observation?: boolean;
  requiresApproval?: boolean;
  approvalDescription?: string;
};

type PendingAction = {
  id: string;
  connector: string;
  method: string;
  args: unknown;
  description?: string;
  provisionalResult: unknown;
  createdAt: number;
};

type ActionResult = {
  result: unknown;
  pending?: PendingAction;
};
```

## Comparison with Gatekeeper

| Concept              | Gatekeeper                         | Codemode                                          |
| -------------------- | ---------------------------------- | ------------------------------------------------- |
| Read classification  | `authorizeObservation()`           | `{ observation: true }`                           |
| Write classification | `submitAction()`                   | `{ requiresApproval: true }`                      |
| Approval queue       | `ApprovalQueue` RpcTarget          | Session facet DO storage                          |
| Simulation           | Gatekeeper simulates pending state | `connector.simulate()` returns provisional result |
| Apply                | `applyAction(action)`              | `session.applyAction(actionId)`                   |
| Reject               | `rejectAction(action)`             | `session.rejectAction(actionId)`                  |
| Revert               | `revertAction(action, revertInfo)` | Future                                            |
