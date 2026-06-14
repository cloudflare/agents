# Think Workflows

`ThinkWorkflow` connects Think to Cloudflare Workflows when a durable job
needs one model-driven reasoning step.

Use it when the Workflow owns the process:

- durable multi-step orchestration
- approval gates or long waits
- retryable deterministic side effects
- a Think turn that should produce typed structured output

Keep recurring prompts as scheduled tasks, and keep simple one-off background
turns on `submitMessages()`. Workflows are for jobs where the steps matter.

## API

Import from `@cloudflare/think/workflows`:

```typescript
import { ThinkWorkflow } from "@cloudflare/think/workflows";
```

Extend `ThinkWorkflow` and call `step.prompt()` inside `run()`:

```typescript
import { z } from "zod";
import { ThinkWorkflow } from "@cloudflare/think/workflows";
import type { ThinkWorkflowStep } from "@cloudflare/think/workflows";
import type { AgentWorkflowEvent } from "agents/workflows";

const draftSchema = z.object({
  title: z.string(),
  summary: z.string(),
  labels: z.array(z.string())
});

export class TriageWorkflow extends ThinkWorkflow<TriageAgent, Params> {
  async run(event: AgentWorkflowEvent<Params>, step: ThinkWorkflowStep) {
    const draft = await step.prompt("triage-issue", {
      prompt: `Triage issue #${event.payload.issueNumber}`,
      output: draftSchema,
      timeout: "3 days"
    });

    await step.do("apply-labels", async () => {
      await this.agent.applyLabels(draft.labels);
    });
  }
}
```

Start the Workflow from inside your Think Agent with `runWorkflow()`:

```typescript
export class TriageAgent extends Think<Env> {
  async triageIssue(issueNumber: number): Promise<string> {
    return this.runWorkflow(
      "TRIAGE_WORKFLOW",
      { issueNumber },
      { metadata: { issueNumber } }
    );
  }
}
```

`runWorkflow()` creates the Workflow instance and injects the Agent identity that
`ThinkWorkflow` needs to reconnect to `this.agent` inside `run()`. Prefer it
over calling the Workflows binding directly:

```typescript
// Avoid this for Agent workflows. It does not include Agent context.
await this.env.TRIAGE_WORKFLOW.create({ params: { issueNumber } });
```

Use `sendWorkflowEvent()` from the Agent when a waiting Workflow needs an
external signal, such as human approval:

```typescript
await this.sendWorkflowEvent("TRIAGE_WORKFLOW", workflowId, {
  type: "approval",
  payload: { approved: true }
});
```

`step.prompt()` accepts a prompt string and a Zod object schema. The schema is
converted to JSON Schema before the Workflow calls the Agent. Think then runs a
full agentic turn: the Agent may use its tools across multiple steps and returns
the structured result by calling an internal `final_answer` tool whose arguments
match the schema. This uses ordinary tool calling rather than a streaming
`response_format`, so it works across every provider Think supports — including
Workers AI, which rejects JSON Schema responses on streaming requests. When the
Workflow resumes, the payload is validated again with the original Zod schema
before the typed value is returned.

Unsupported Zod features that cannot be represented as JSON Schema fail while
creating the prompt step. Think does not silently repair invalid model output.
If the model does not produce a valid `final_answer` call, the submission reaches
a terminal error state and `step.prompt()` throws.

### Behavior notes

- **The Agent may use its tools first.** A `step.prompt()` turn is a full agentic
  turn: the Agent can call its own tools across multiple steps and then call the
  final-answer tool. Allow at least `maxSteps: 2` if you expect the Agent to use
  a tool before answering — with `maxSteps: 1` it is forced to answer on the
  first step and cannot call any other tool.
- **Tool use is forced during a structured turn.** To guarantee the Agent
  terminates with a structured answer (rather than replying in plain text), Think
  sets `toolChoice` for the turn. Do not override `toolChoice` from `beforeTurn`
  on a `step.prompt()` turn — doing so can prevent the Agent from calling the
  final-answer tool, which makes the prompt fail.
- **`think_final_answer` is reserved.** Think injects an internal
  `think_final_answer` tool to carry the structured result. This name (and any
  `think_final_answer_*` variant) is reserved; its call and result are stripped
  from the persisted conversation, so the transcript and later turns do not see
  Think's internal plumbing.
- **The model must support streaming tool calls.** Think streams every turn, so
  `step.prompt()` works only with models that reliably emit a forced tool call
  while streaming. Strong tool-callers (for example OpenAI `gpt-4o-mini`,
  Anthropic `claude-haiku-4-5`, and Workers AI `@cf/moonshotai/kimi-k2.7-code`) are
  verified to work. Some models honor a forced `toolChoice` only on
  non-streaming requests and will reply in plain text and stop while streaming —
  for example Workers AI `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. With those
  models the turn ends without a `think_final_answer` call and `step.prompt()`
  fails (`Model ended the turn without calling the think_final_answer tool`); use
  a model with working streaming tool calls instead.

## How It Runs

The call reads like a blocking step, but it does not hold a long-lived Durable
Object RPC open.

1. `step.do("<name>:submit", ...)` creates or finds an idempotent Think
   submission.
2. Think runs the submitted turn through the normal submission queue.
3. When the submission reaches `completed`, `error`, `aborted`, or `skipped`,
   Think records a pending workflow notification.
4. Think drains the notification outbox with `sendWorkflowEvent()` and Durable
   Object alarms until delivery succeeds.
5. `step.waitForEvent("<name>:wait", ...)` resumes the Workflow.
6. `step.prompt()` validates the structured output or throws a typed error.

The machine-readable output is carried in the pending notification and Workflow
event payload. Think does not store a separate `output_json` column on the
submission ledger, and clears the notification payload after delivery. After
delivery, the Workflow owns the durable result.

## Idempotency

By default, `step.prompt()` infers the idempotency key from Workflow identity and
step name:

```text
think-workflow:<workflowName>:<workflowId>:<stepName>
```

For loops, pass a string `key` to distinguish repeated uses of the same step
name:

```typescript
await step.prompt("summarize-file", {
  key: file.path,
  prompt: `Summarize ${file.path}`,
  output: summarySchema
});
```

Prompt text is not part of the inferred key, but Think stores workflow metadata
and a prompt/config fingerprint for diagnostics.

## Timeouts

Pass `timeout` to control how long the Workflow waits for the terminal event.
If the wait times out, `step.prompt()` cancels the Think submission by default
and throws `ThinkPromptTimeoutError`.

Set `cancelOnTimeout: false` when you intentionally want the Think submission to
continue after the Workflow stops waiting.

## Boundary With Other Primitives

Use `getScheduledTasks()` for recurring prompt submissions or deterministic
scheduled handlers:

```typescript
getScheduledTasks() {
  return {
    dailySummary: {
      schedule: "every day at 09:00",
      timezone: "UTC",
      prompt: "Generate the daily report."
    },
    dailyWorkflow: {
      schedule: "every day at 09:00",
      timezone: "UTC",
      retry: { maxAttempts: 3 },
      handler: async ({ idempotencyKey, scheduledFor, timezone }) => {
        await this.env.REPORT_WORKFLOW.create({
          id: idempotencyKey,
          params: { scheduledFor, timezone }
        });
      }
    }
  };
}
```

Use `submitMessages()` for durable one-off turns where the caller can inspect
submission status later.

Use `startFiber()` for app-owned idempotent Agent jobs that need recovery inside
the Agent. Think's workflow notification delivery does not use fibers; it uses a
private outbox because it needs to store an event until delivery succeeds.

Use Workflows when the process has multiple deterministic steps, long waits, or
human approval.
