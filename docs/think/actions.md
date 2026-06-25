# Actions

> **Experimental.** The API surface may evolve before Think graduates out of
> experimental.

Actions are server-side tools with batteries included. Where a plain AI SDK
`tool()` is just a description, a schema, and an `execute` function, an
`action()` adds the things that are tedious and dangerous to get right by hand
for a tool that has real side effects:

- **Idempotency** — a durable ledger replays a settled result by a stable key
  instead of re-running the side effect on a recovery retry.
- **Approvals** — gate a call behind a human, either inline (the turn waits) or
  durably (the turn parks and resumes later, even from a dashboard with no live
  socket).
- **Authorization** — declare the permissions a call requires and grant them
  per-turn.
- **Reply attachments** — record advisory delivery metadata (a drafted email, a
  card, a voice note) without changing what the model sees.

Actions compile into Think tools, so the model calls them exactly like any other
tool. Return them from `getActions()`; Think merges them into the tool set
alongside `getTools()`, workspace tools, extensions, and MCP tools.

## Define an action

Use the `action()` descriptor factory and return a map of actions from
`getActions()`. The map key is the tool name the model sees (unless you set
`name`). The `execute` input type is inferred from `inputSchema`:

```typescript
import { Think, action } from "@cloudflare/think";
import { z } from "zod";

export class Support extends Think<Env> {
  getActions() {
    return {
      refundOrder: action({
        description: "Refund a customer order.",
        inputSchema: z.object({
          orderId: z.string(),
          amountCents: z.number().int().positive()
        }),
        execute: async ({ orderId, amountCents }, ctx) => {
          const result = await refund(orderId, amountCents);
          return { refundId: result.id, status: result.status };
        }
      })
    };
  }
}
```

The `execute` callback receives the validated input and an `ActionContext`:

```typescript
type ActionContext = {
  agent: Think;
  env: Cloudflare.Env;
  requestId: string;
  toolCallId: string;
  messages: ReadonlyArray<ModelMessage>;
  signal: AbortSignal; // aborts on turn cancel or after `timeoutMs`
  attachReply(attachment: ReplyAttachment): void;
};
```

The action output is normalized to JSON and truncated before it is shown to the
model (long outputs are capped). Anything thrown from `execute` becomes a
structured `{ error: { name, message } }` tool result rather than crashing the
turn. Each action has a default timeout of 30 seconds; override it per action
with `timeoutMs`.

### Actions versus plain tools

A plain `tool()` from `getTools()` still works and is the right choice for a
read-only or trivial tool. Reach for `action()` when a tool has side effects you
must not run twice, needs human approval, or needs declarative authorization —
the ledger, approval descriptors, default timeout, and structured error mapping
only apply to actions.

## Idempotency and the action ledger

When an action declares an `idempotencyKey`, Think records the settled result in
a durable ledger keyed by `action:<name>:<key>`. If the same key is seen again —
on a recovery retry, a reconnect, or a duplicate inbound event — Think returns
the stored result **without** re-running `execute`, so the side effect happens
at most once on the happy path.

```typescript
chargeInvoice: action({
  description: "Charge an invoice.",
  inputSchema: z.object({ invoiceId: z.string() }),
  // Use a stable domain identifier — never a timestamp, request id, or random value.
  idempotencyKey: ({ input }) => `invoice:${input.invoiceId}`,
  execute: async ({ invoiceId }) => charge(invoiceId)
});
```

`idempotencyKey` is a string, or a function `({ input, ctx }) => string`. Choose
a key that survives recovery retries — an order id, an inbound event id — and
not a value that changes per attempt. An action with no `idempotencyKey` falls
back to a per-`toolCallId` key, which only deduplicates within the same tool
call, not across retries.

### Pending rows and the retry lease

A ledger row is written as `pending` before `execute` runs and flipped to
`settled` on success (a thrown or timed-out `execute` deletes the row so the
call can be retried cleanly). If the isolate dies mid-execute, the row is left
`pending`. By default such a stale row is reclaimed and the action re-run once
the row is older than `actionLedgerPendingRetryLeaseMs` (default 5 minutes) —
**but only for actions that declare an explicit `idempotencyKey`**, since that
key is your assertion that re-running the keyed side effect is safe. A fresh
pending row (or one without an explicit key) instead returns an
`ActionPendingError` result so the model does not blindly retry an unknown
state. Set `actionLedgerPendingRetryLeaseMs = false` to disable reclaim entirely
and always surface `ActionPendingError` for a stale row.

## Approvals

Gate an action behind a human with `approval`. There are two mechanisms,
selected by `kind`.

### Approval-gated (the turn waits)

The default when you set `approval` without a `kind`. The action compiles to a
tool with the AI SDK `needsApproval` flag: the stream pauses with an
`approval-requested` part, the client approves or rejects, and the turn
continues inline. `execute` runs only after approval.

```typescript
deleteAccount: action({
  description: "Permanently delete a user account.",
  inputSchema: z.object({ userId: z.string() }),
  approval: true, // or ({ input }) => input.userId !== currentUser
  approvalSummary: "Delete an account",
  approvalRisk: "high",
  execute: async ({ userId }) => deleteAccount(userId)
});
```

`approval` is a boolean or a predicate `({ input, ctx }) => boolean`, so you can
require approval only for risky inputs. `approvalSummary` and `approvalRisk`
(`"low" | "medium" | "high"`) populate the approval descriptor your UI renders.

### Durable-pause (the turn parks and resumes later)

Set `kind: "durable-pause"` when approval may take minutes or days and you do not
want to hold a connection open. The action parks into a durable store and the
turn ends; `execute` does not run yet. Resume later — from anywhere, including a
dashboard with no live WebSocket — with `approveExecution()` or
`rejectExecution()`:

```typescript
deploy: action({
  description: "Deploy to production.",
  inputSchema: z.object({ ref: z.string() }),
  kind: "durable-pause",
  approvalSummary: "Deploy to production",
  approvalRisk: "high",
  permissions: ["deploy:run"],
  execute: async ({ ref }) => deploy(ref)
});
```

```typescript
// List everything waiting on a human (cold-load reconciliation):
const pending = await agent.pendingApprovals();
// [{ executionId, source: "action" | "codemode", descriptor }]

// Approve or reject by execution id (idempotent — a second call is a no-op):
await agent.approveExecution(executionId);
await agent.rejectExecution(executionId, "Not this release");
```

`approveExecution()` runs `execute` once and auto-continues the turn even if no
client is connected; `rejectExecution()` resolves the action without running it.
`pendingApprovals()` merges parked actions and paused Codemode executions, so a
single approval UI can drive both. (`durable-pause` requires an `approval`
policy — an action that would never park is rejected at definition time.)

Both approval-gated and durable-pause parts carry a stable
`ActionApprovalDescriptor` (`{ requestId, toolCallId, action, summary, input,
permissions, risk, kind }`) so your UI has everything it needs to render the
prompt.

## Authorization

Declare the permissions an action requires with `permissions`, then grant them
per turn. By default every turn is fully authorized, so authorization is opt-in.

```typescript
refundOrder: action({
  description: "Refund a customer order.",
  inputSchema: z.object({ orderId: z.string() }),
  permissions: ["billing:refund"], // or ({ input }) => [...]
  execute: async ({ orderId }) => refund(orderId)
});
```

Override `authorizeTurn()` to decide, once per turn, which permissions are
granted. Returning a list narrows the grant; any action requiring a permission
outside the set is denied with a structured `ActionAuthorizationError` (the model
never calls `execute`):

```typescript
export class Support extends Think<Env> {
  override authorizeTurn(ctx: TurnContext): ActionAuthorizationDecision {
    const role = (ctx.body as { role?: string })?.role;
    if (role === "admin") return true; // full grant (the default)
    return { allowed: true, grantedPermissions: ["billing:read"] };
  }
}
```

`authorizeTurn()` returns `true` (full grant), `false` (deny all), or
`{ allowed, reason?, grantedPermissions? }`. For per-call logic, override
`authorizeAction(ctx)` instead — it receives the action name, kind, input, and
required and granted permissions.

## Reply attachments

An action can record advisory delivery metadata for the turn — a drafted email,
a card, a voice note — with `ctx.attachReply()`. Attachments never change the
tool output the model sees; they ride alongside the response for your delivery
layer to render.

```typescript
draftReply: action({
  description: "Draft an email reply.",
  inputSchema: z.object({ to: z.string(), subject: z.string() }),
  execute: async ({ to, subject }, ctx) => {
    ctx.attachReply({ type: "email_draft", to: [to], subject });
    return { drafted: true };
  }
});
```

Read the attachments after the turn from the `onChatResponse()` hook, or from the
`replyAttachments(requestId?)` getter:

```typescript
override async onChatResponse(result: ChatResponseResult) {
  for (const attachment of result.attachments ?? []) {
    // attachment.type === "email_draft" | "card" | "voice_note" | custom
  }
}
```

Attachments are JSON-normalized and deep-copied on read, capped per turn, and
discarded if the `execute` that recorded them fails. A ledger replay does not
re-fire attachments (the side effect already happened), and `attachReply()` is a
no-op when called from a `permissions`, `approval`, or `idempotencyKey` callback
— record attachments from `execute`.

A built-in `ReplyAttachment` covers `email_draft`, `card`, and `voice_note`; any
`{ type: string; ... }` shape is allowed for custom delivery. Override
[`renderAttachment()`](./channels.md#deliver-out-of-band) to turn an attachment
into a channel notice.

## Reference

### `action(config)`

| Field             | Type                                                         | Required | Default       | Description                                                                             |
| ----------------- | ------------------------------------------------------------ | -------- | ------------- | --------------------------------------------------------------------------------------- |
| `description`     | `string`                                                     | Yes      | —             | Tool description shown to the model.                                                    |
| `inputSchema`     | `FlexibleSchema` (Zod or AI SDK `jsonSchema`)                | Yes      | —             | Validates and types the `execute` input.                                                |
| `execute`         | `(input, ctx) => Output \| Promise<Output>`                  | Yes      | —             | The action body. Receives validated input and an `ActionContext`.                       |
| `name`            | `string`                                                     | No       | map key       | Overrides the tool name.                                                                |
| `idempotencyKey`  | `string \| ({ input, ctx }) => string`                       | No       | per tool call | Stable key for ledger replay. Use a domain identifier.                                  |
| `permissions`     | `readonly string[] \| ({ input, ctx }) => readonly string[]` | No       | none          | Permissions this call requires (see Authorization).                                     |
| `approval`        | `boolean \| ({ input, ctx }) => boolean`                     | No       | none          | Gate the call behind a human.                                                           |
| `approvalSummary` | `string`                                                     | No       | `description` | Human-readable summary in the approval descriptor.                                      |
| `approvalRisk`    | `"low" \| "medium" \| "high"`                                | No       | —             | Risk hint in the approval descriptor.                                                   |
| `kind`            | `"server" \| "approval-gated" \| "durable-pause"`            | No       | inferred      | `approval-gated` when `approval` is set, else `server`; set `durable-pause` explicitly. |
| `timeoutMs`       | `number`                                                     | No       | `30000`       | Per-action execution timeout (also drives `ctx.signal`).                                |

### Hooks and methods on the agent

| Member                                  | Description                                                                        |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| `getActions()`                          | Return the action descriptors to compile into tools.                               |
| `authorizeTurn(ctx)`                    | Decide granted permissions once per turn. Defaults to full grant.                  |
| `authorizeAction(ctx)`                  | Decide authorization per action call. Defaults to checking `authorizeTurn` grants. |
| `pendingApprovals(executionId?)`        | List parked actions and paused Codemode executions awaiting approval.              |
| `approveExecution(executionId)`         | Approve a parked execution; runs `execute` and auto-continues the turn.            |
| `rejectExecution(executionId, reason?)` | Reject a parked execution without running it.                                      |
| `replyAttachments(requestId?)`          | Read the advisory attachments recorded during a turn.                              |
| `actionLedgerPendingRetryLeaseMs`       | Stale-pending reclaim window (default `300000`; `false` to disable).               |

## Related

- [Tools](./tools.md) — workspace tools, code execution, and extensions.
- [Human in the Loop](https://github.com/cloudflare/agents/blob/main/docs/agents/human-in-the-loop.md) — the approval flow end to end.
- [Channels](./channels.md) — deliver attachments and out-of-band notices.
