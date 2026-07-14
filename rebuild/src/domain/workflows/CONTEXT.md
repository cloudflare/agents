# Workflows

A local tracking table and 1:1 control API fronting Cloudflare Workflows bindings
via the WorkflowRuntime port. The workflow *engine* is out of scope; this context
owns only the tracking rows and control surface. Wired by Agent, never Think. See
the [context map](../../../CONTEXT-MAP.md).

## Language

**Workflow**:
A tracked long-running process fronted by a Cloudflare Workflows binding,
represented locally by a tracking row.
_Avoid_: job, pipeline, saga

**Tracking row**:
The local record of a workflow (workflow id, workflow name, status, metadata,
output, error, timestamps). Runtime terminal states override the local row.
_Avoid_: WorkflowInfo (the type name — prefer "tracking row" in prose)

**WorkflowStatus**:
The lifecycle state: running, paused, completed, errored, or terminated.

**Control methods**:
The 1:1 lifecycle operations over a workflow: run, sendEvent, approve/reject,
terminate, pause, resume, restart, status.

**Approval (workflow)**:
Sugar over `sendEvent` with the reserved `approval` event type and an
`{ approved, reason }` payload.
_Avoid_: confusing with an **Action** approval — different context.

**onCallback**:
The inbound callback the workflow side invokes (progress / complete / error); an
unknown workflow id is reported as an unrecognized (stale) callback.

**migrateBinding**:
Rewriting the workflow name across tracking rows when a binding is renamed.
