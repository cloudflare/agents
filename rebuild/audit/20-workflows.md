# 20 — Workflow tracking

Original: a large method cluster on `Agent` (`runWorkflow`, `sendWorkflowEvent`,
`approveWorkflow`/`rejectWorkflow`, `terminateWorkflow`, `pauseWorkflow`,
`resumeWorkflow`, `restartWorkflow`, `getWorkflowStatus`, `getWorkflow(s)`,
`deleteWorkflow(s)`, `migrateWorkflowBinding`, `onWorkflowCallback`,
`onWorkflowProgress`, `onWorkflowComplete`) that fronts Cloudflare Workflows
bindings and keeps a local tracking table. The engine is out of scope; the
tracking service + API shape is in scope, delegating to the `WorkflowRuntime`
port (doc 02).

## Behaviors to preserve

1. `run(workflowName, { id?, params?, metadata? })`: id defaults to a new id;
   insert tracking row `{ workflowId, workflowName, status: "running",
   params?, metadata?, createdAt, updatedAt }` (prefix `wf:`), then
   `runtime.create`. Emit `workflow:start`. Duplicate id with a live row →
   ConflictError.
2. Control methods map 1:1 to the runtime + status transitions + events:
   - `sendEvent(id, { type, payload })` → `workflow:event` (no status change).
   - `approve(id, reason?)` / `reject(id, reason?)` → sugar for sendEvent with
     the reserved event types `"approval"` payload `{ approved, reason }`;
     emit `workflow:approved|rejected`.
   - `terminate(id)` → status `terminated`; `pause(id)` → `paused`;
     `resume(id)` → `running`; `restart(id)` → `running`, emits
     `workflow:restarted`.
   - Control of an unknown id → NotFoundError.
3. `status(id)`: consult the runtime (`runtime.status`) and sync the local
   row (runtime terminal states override local); returns merged
   `{ workflowId, workflowName, status, output?, error? }`.
4. Queries against local rows only: `get(id)`, `list(criteria)` with
   `{ status?, workflowName?, limit?, offset? }` returning a page
   `{ workflows, total }`; `delete(id)` (bool), `deleteMany(criteria)`
   (settled-only by default), `migrateBinding(oldName, newName)` → rewrites
   `workflowName` on rows, returns count.
5. **Callbacks from the workflow side** (the original exposes an HTTP/RPC
   callback the workflow invokes): `onCallback({ workflowId, kind, payload })`
   with kind `progress | complete | error`:
   - progress → invoke host hook `onProgress(row, payload)`; update
     `updatedAt`;
   - complete → status `completed`, store output, hook `onComplete`;
   - error → status `errored`, store error message.
   Unknown workflowId → ignore (stale callback) but return
   `{ recognized: false }`.

## Proposed interface

```ts
export type WorkflowStatus = "running" | "paused" | "completed" | "errored" | "terminated";
export interface WorkflowInfo { workflowId: string; workflowName: string; status: WorkflowStatus;
  metadata?: Record<string, unknown>; output?: unknown; error?: string; createdAt: number; updatedAt: number }

export interface WorkflowService {
  run(workflowName: string, options?: { id?: string; params?: unknown; metadata?: Record<string, unknown> }): Promise<WorkflowInfo>;
  sendEvent(workflowId: string, event: { type: string; payload?: unknown }): Promise<void>;
  approve(workflowId: string, reason?: string): Promise<void>;
  reject(workflowId: string, reason?: string): Promise<void>;
  terminate(workflowId: string): Promise<void>;
  pause(workflowId: string): Promise<void>;
  resume(workflowId: string): Promise<void>;
  restart(workflowId: string): Promise<void>;
  status(workflowId: string): Promise<WorkflowInfo>;
  get(workflowId: string): WorkflowInfo | undefined;
  list(criteria?: { status?: WorkflowStatus[]; workflowName?: string; limit?: number; offset?: number }): { workflows: WorkflowInfo[]; total: number };
  delete(workflowId: string): boolean;
  deleteMany(criteria?: { status?: WorkflowStatus[]; updatedBefore?: number }): number;
  migrateBinding(oldName: string, newName: string): number;
  onCallback(cb: { workflowId: string; kind: "progress" | "complete" | "error"; payload?: unknown }): Promise<{ recognized: boolean }>;
}
export function createWorkflowService(deps: {
  store: KeyValueStore; runtime: WorkflowRuntime; clock: Clock; ids: IdSource; bus: EventBus;
  hooks?: { onProgress?: (wf: WorkflowInfo, payload: unknown) => void | Promise<void>;
            onComplete?: (wf: WorkflowInfo) => void | Promise<void>; };
}): WorkflowService;
```

## Tests
- run inserts + delegates + event; duplicate live id conflict.
- control transitions + events; unknown id NotFound.
- status syncs terminal runtime state into local row.
- list paging/filtering; deleteMany settled-only default; migrateBinding count.
- onCallback matrix incl. unrecognized id.
