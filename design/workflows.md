# Workflows

**Internal.** Not a public API. Nothing new from the slim-hosts work is exposed to apps until it has shipped inside `Think` and `AIChatAgent` for a release and is shown correct ([rfc-slim-hosts.md](./rfc-slim-hosts.md#exposure)). It is not exported at all: `Agent` installs it and delegates its public methods to it.

`Agent.runWorkflow()` starts a [Cloudflare Workflow](https://developers.cloudflare.com/workflows/) instance on the agent's behalf, and the agent keeps a record of every instance it started. The control methods (`sendWorkflowEvent`, `approveWorkflow`, `rejectWorkflow`, `terminateWorkflow`, `pauseWorkflow`, `resumeWorkflow`, `restartWorkflow`, `getWorkflowStatus`) and the record queries (`getWorkflow`, `getWorkflows`, `deleteWorkflow`, `deleteWorkflows`, `migrateWorkflowBinding`) are one-line delegates to the `Workflows` Lifecycle capability in `packages/agents/src/workflow-tracking/`. The hooks stay on Agent: `onWorkflowCallback`, `onWorkflowProgress`, `onWorkflowComplete`, `onWorkflowError`, `onWorkflowEvent`, and the `_workflow_*` RPC methods `AgentWorkflow` calls. `AgentWorkflow` itself is in `src/workflows.ts`.

The capability is internal. Agent installs it with the Worker env and a function that names the owner: a top-level agent by class and name, or a facet by its path from the root.

## How it works

### Durable and in memory

- Durable: `cf_agents_workflows`, one row per instance started through `run()`: id, instance id, binding name, status, metadata, error, created/updated/completed times. The capability creates it on first use under the KV key `cf_agents:workflows_schema_version`.
- In memory: nothing.

The Workflows service holds the real status of an instance. The row mirrors it and can lag: it changes when a control call reads the status back, when `getWorkflowStatus()` runs, and when an `AgentWorkflow` callback arrives (`record()`).

### Starting

`run()` finds the Workflow binding in env, works out the origin callbacks route back to, and calls `workflow.create()` with the owner's identity in the params (`__agentName`, `__agentBinding`, `__workflowName`, `__agentOrigin`; built by `workflowCreateOptions()`). The origin is `{ kind: "agent", binding, name }`, or for a facet `{ kind: "facet", rootBinding, path }`. The binding is `options.agentBinding` or the env namespace whose name matches the class name (exact, or equal in kebab case). Then it inserts the row as `queued`.

### Callbacks

`onWorkflowCallback()` calls `record(callback)` and then the matching hook. `record()` applies these rules:

- `progress` moves `queued` or `waiting` to `running`.
- `complete` and `error` never overwrite `terminated` or `paused`. A pause or terminate that raced the workflow's own last report keeps the state the caller asked for.
- `event` changes nothing.

A subclass that overrides `onWorkflowCallback()` without calling `super` skips the record update, as before.

### Startup

On start the capability warns about rows whose binding is not in env any more, usually a renamed binding, and suggests `migrateWorkflowBinding()`.

## Tradeoffs

- `approveWorkflow()` and `rejectWorkflow()` send their event through the capability, not through `this.sendWorkflowEvent()`. A subclass override of `sendWorkflowEvent()` no longer sees approvals.
- Pagination is keyset on `(created_at, workflow_id)`. `total` counts every match and ignores the cursor.
