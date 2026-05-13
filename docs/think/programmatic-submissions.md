# Programmatic Submissions

Use `submitMessages()` when a caller needs to start a Think turn, return
quickly, retry safely, and inspect the result later.

`saveMessages()` waits for the turn to finish. `submitMessages()` durably accepts
the turn and returns a submission record before inference runs.

For a broader comparison with `chat()`, `saveMessages()`, and agent tools, see
[Choosing a turn API](./index.md#choosing-a-turn-api).

## Why this exists

Webhook handlers, RPC callers, and parent Workers often have strict timeout
limits. If they call `saveMessages()` and time out, they cannot tell whether the
turn was never accepted, is queued, is running, or already completed. Retrying
can duplicate a user message and start a second turn.

`submitMessages()` creates a durable acceptance boundary:

```typescript
const submission = await this.submitMessages(
  [
    {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: "Process webhook event 123" }]
    }
  ],
  { idempotencyKey: "webhook-event-123" }
);
```

The caller can return `submission.submissionId` immediately. Later, call
`inspectSubmission(submissionId)` or `listSubmissions()` to inspect status.

## API

```typescript
const submission = await this.submitMessages(messages, {
  submissionId: "optional-stable-id",
  idempotencyKey: "external-job-id",
  metadata: { source: "webhook" }
});
```

`submitMessages()` accepts serializable `UIMessage[]` values. It does not accept
the function form supported by `saveMessages((messages) => ...)`, because
durable submissions persist work before execution and cannot store closures.
The array must contain at least one message.

## Statuses

| Status      | Meaning                                        |
| ----------- | ---------------------------------------------- |
| `pending`   | Accepted and waiting for its turn              |
| `running`   | Claimed by the agent and executing             |
| `completed` | The Think turn completed successfully          |
| `aborted`   | The submission was cancelled                   |
| `skipped`   | Turn state was reset before the submission ran |
| `error`     | Execution failed or recovery was unsafe        |

## Idempotent retries

Pass an `idempotencyKey` from your external system. Retrying with the same key
returns the existing submission with `accepted: false` instead of inserting
duplicate messages:

```typescript
const first = await this.submitMessages(messages, {
  idempotencyKey: payload.id
});

const retry = await this.submitMessages(messages, {
  idempotencyKey: payload.id
});

// retry.submissionId === first.submissionId
// retry.accepted === false
```

If you pass both `submissionId` and `idempotencyKey`, they must identify the same
submission. If they point at different existing rows, `submitMessages()` throws
instead of choosing one identity over the other.

## Inspect, list, and cancel

```typescript
const current = await this.inspectSubmission(submission.submissionId);

const active = await this.listSubmissions({
  status: ["pending", "running"]
});

await this.cancelSubmission(submission.submissionId, "No longer needed");
```

Use `cancelSubmission(submissionId)` for durable cancellation. This works across
Worker and Durable Object RPC boundaries, unlike `AbortSignal`.

Completed submission records are retained until you delete them:

```typescript
await this.deleteSubmissions({
  status: ["completed", "error", "aborted"],
  completedBefore: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
});
```

## Session behavior

Think stores accepted submissions in a submission ledger first. It appends the
submitted messages to the conversation `Session` only when the submission starts
executing. This preserves FIFO turn semantics: later accepted submissions are
not visible to the model until their own turn starts.

If the chat is cleared or turn state is reset before a pending submission runs,
that submission is marked `skipped`.

## Compared with `saveMessages`

Use `saveMessages()` when the caller can wait for the full turn:

```typescript
const result = await this.saveMessages(messages);
// result.status is final
```

Use `submitMessages()` when timeout ambiguity would make retries unsafe:

```typescript
const result = await this.submitMessages(messages, { idempotencyKey });
// result.status is the accepted submission state
```

`waitUntilStable()` is still useful when the caller needs to avoid accepting new
work while the current chat UI is mid-turn. It is not required for durable
admission: accepted submissions are serialized by Think and do not append their
messages to the session until their own turn starts.

## Compared with Workflows

Use `submitMessages()` for one durable Think chat turn.

Use Workflows for multi-step orchestration: retries per step, long waits,
external events, human approvals, or pipelines that may trigger Think as one
part of a larger process.

Workflows can compose with this API:

```typescript
const submission = await this.agent.submitMessages(messages, {
  idempotencyKey: event.payload.jobId
});
```

## Example

See [Think Durable Submissions](../../examples/think-submissions/README.md) for
a full dashboard that shows immediate ACKs, idempotent retry, queue status, and
cancellation.
