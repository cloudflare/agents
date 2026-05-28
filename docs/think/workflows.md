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
converted to JSON Schema before the Workflow calls the Agent, then Think
reconstructs the AI SDK structured output configuration for the turn. When the
Workflow resumes, the payload is validated again with the original Zod schema
before the typed value is returned.

Unsupported Zod features that cannot be represented as JSON Schema fail while
creating the prompt step. Think does not silently repair invalid model output.
If the model or provider cannot produce valid output, the submission reaches a
terminal error state and `step.prompt()` throws.

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

Use scheduled tasks for recurring prompts:

```typescript
async onScheduled() {
  await this.saveMessages([{ role: "user", parts: [{ type: "text", text: "Daily summary" }] }]);
}
```

Use `submitMessages()` for durable one-off turns where the caller can inspect
submission status later.

Use `startFiber()` for app-owned idempotent Agent jobs that need recovery inside
the Agent. Think's workflow notification delivery does not use fibers; it uses a
private outbox because it needs to store an event until delivery succeeds.

Use Workflows when the process has multiple deterministic steps, long waits, or
human approval.
