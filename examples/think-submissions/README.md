# Think Durable Submissions

A focused demo of durable programmatic Think turns. It shows how to submit a
message turn, receive an immediate durable ACK, retry safely with an
idempotency key, inspect status later, cancel active work, and declare a
recurring scheduled task.

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
6. Inspect the code-declared hourly scheduled task. To watch it fire quickly
   during local development, temporarily change it to `every 5 minutes`.

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

The same durable submission path is used by declarative scheduled tasks:

```ts
getScheduledTasks(): ThinkScheduledTasks {
  return {
    hourlyQueueDigest: {
      schedule: "every 1 hour",
      prompt:
        "Write a concise hourly reminder that durable background task queues should be checked for stuck or failed work."
    }
  };
}
```

Think reconciles this declaration on startup, schedules the next occurrence, and
submits each run with a stable idempotency key so retries do not duplicate work.
The example uses an hourly cadence to avoid surprising model usage; shorten it
locally if you want to watch automatic submissions appear while the dashboard is
open.

## Server

`src/server.ts` defines `TaskAgent extends Think` and exposes callable methods:

- `submitTask(prompt, idempotencyKey)` wraps `submitMessages()`.
- `inspectTask(submissionId)` wraps `inspectSubmission()`.
- `listTasks(status?)` wraps `listSubmissions()`.
- `cancelTask(submissionId)` wraps `cancelSubmission()`.
- `getScheduledTasks()` declares an hourly background digest.

## Client

`src/client.tsx` is a submission dashboard, not a normal chat UI. It highlights
the lifecycle that matters for server-to-server callers: durable acceptance,
idempotent retry, queue status, cancellation, and terminal history.

## When to Use This

- Use `saveMessages()` when the caller can wait for the Think turn to finish.
- Use `submitMessages()` when the caller needs a fast durable receipt and safe
  retry.
- Use `startFiber()` around the submission when the caller also owns external
  side effects, such as accepting a webhook once, restoring provider state, and
  posting a visible reply.
- Use `getScheduledTasks()` when the same durable Think turn should be created
  on a recurring schedule.
- Use Workflows when the job is a multi-step process with retries, approvals,
  or long waits beyond one Think turn.
