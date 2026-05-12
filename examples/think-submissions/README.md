# Think Durable Submissions

A focused demo of durable programmatic Think turns. It shows how to submit a
message turn, receive an immediate durable ACK, retry safely with an
idempotency key, inspect status later, and cancel active work.

## Run

```sh
npm install
npm start
```

Open the dev URL and use the dashboard to:

1. Submit a prompt.
2. See the immediate `{ submissionId, accepted, status }` receipt.
3. Watch the submission move through `pending`, `running`, and a terminal status.
4. Retry with the same idempotency key and confirm no duplicate turn is created.
5. Cancel a pending or running submission.

## What It Demonstrates

Use `submitMessages()` when a webhook, RPC caller, or parent Worker needs to
start a Think turn but cannot wait for the model response.

```ts
const submission = await this.submitMessages(
  [
    {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: prompt }]
    }
  ],
  { idempotencyKey: externalJobId }
);
```

The caller can return `submission.submissionId` immediately, then poll or render
`inspectSubmission()` / `listSubmissions()` later.

## Server

`src/server.ts` defines `TaskAgent extends Think` and exposes callable methods:

- `submitTask(prompt, idempotencyKey)` wraps `submitMessages()`.
- `inspectTask(submissionId)` wraps `inspectSubmission()`.
- `listTasks(status?)` wraps `listSubmissions()`.
- `cancelTask(submissionId)` wraps `cancelSubmission()`.

## Client

`src/client.tsx` is a submission dashboard, not a normal chat UI. It highlights
the lifecycle that matters for server-to-server callers: durable acceptance,
idempotent retry, queue status, cancellation, and terminal history.

## When to Use This

- Use `saveMessages()` when the caller can wait for the Think turn to finish.
- Use `submitMessages()` when the caller needs a fast durable receipt and safe
  retry.
- Use Workflows when the job is a multi-step process with retries, approvals,
  or long waits beyond one Think turn.
