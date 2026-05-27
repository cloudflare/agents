# Think Workflows

This example shows how `ThinkWorkflow` lets a Workflow run one durable
Think reasoning step, wait for human approval, then apply a deterministic side
effect.

## Run

```bash
npm install
npm run dev
```

Start a report workflow. The response includes both `workflowId` and `reportId`:

```bash
curl -X POST http://localhost:8787/reports \
  -H "Content-Type: application/json" \
  -d '{"topic":"weekly incident trends"}'
```

Approve the waiting workflow with the returned `workflowId`:

```bash
curl -X POST http://localhost:8787/reports/<workflowId>/approval \
  -H "Content-Type: application/json" \
  -d '{"approved":true,"notes":"Looks good"}'
```

Reject the workflow instead:

```bash
curl -X POST http://localhost:8787/reports/<workflowId>/approval \
  -H "Content-Type: application/json" \
  -d '{"approved":false,"notes":"Needs more detail"}'
```

Fetch the saved draft, approval, or rejection with the returned `reportId`:

```bash
curl http://localhost:8787/reports/<reportId>
```

## Key Pattern

Start the Workflow from an Agent method with `runWorkflow()`:

```typescript
async startReport(topic: string) {
  const reportId = crypto.randomUUID();
  const workflowId = await this.runWorkflow(
    "REPORT_WORKFLOW",
    { reportId, topic },
    { metadata: { reportId, topic } }
  );
  return { reportId, workflowId };
}
```

Then the Workflow can call back into the originating Agent and use
`step.prompt()`:

```typescript
const draft = await step.prompt("draft-report", {
  prompt: `Draft an operational report about: ${event.payload.topic}`,
  output: reportDraftSchema,
  timeout: "3 days"
});

const approvalEvent = await step.waitForEvent("wait-for-approval", {
  type: "approval",
  timeout: "7 days"
});
const approval = approvalEvent.payload as {
  approved: boolean;
  reason?: string;
  metadata?: { notes?: string };
};

if (!approval.approved) {
  await step.do("store-rejection", async () => {
    await this.agent.saveReport({ draft, status: "rejected" });
  });
  return;
}

await step.do("publish-or-reject", async () => {
  await this.agent.saveReport({
    draft,
    status: "approved",
    approvalNotes: approval.metadata?.notes
  });
});
```

`step.prompt()` submits the Think turn, waits for a Workflow event, validates the
structured output, and returns the typed result. The Workflow still owns the
multi-step process and all deterministic side effects.
