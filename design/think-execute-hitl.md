# Think HITL Bridge for Durable Executions

**Status:** experimental (`@cloudflare/think` + `@cloudflare/codemode`)

## Problem

A `requiresApproval` connector call inside the execute tool pauses the codemode run durably. Something has to carry that pause to a human, collect the decision, and resume the run — without parking the chat turn, pinning the isolate, or inventing a second approval protocol next to the AI SDK's per-tool one.

## How It Works

The pause is **model-mediated**: `{ status: "paused", executionId, pending }` is a _normal tool output_. The step completes, the model narrates what it needs and why, and the turn ends naturally. Nothing is parked — the pause lives in the codemode facet, so DO eviction is free and the approval can arrive hours later, from another tab or device.

```
Model ── execute({code}) ──► CodemodeRuntime ──► {status:"paused", pending}
Model narrates ──► client renders an approval card from the paused output part
Client ── approveExecution(executionId) callable ──► runtime.approve()
        outcome (completed / paused-again / error) replaces the paused output
        in the transcript ──► auto-continuation ──► model sees the result
```

The pieces:

- **`pausedExecutionUpdate`** (`agents/chat/tool-state.ts`): an update descriptor that replaces the output of an `output-available` part whose current output is a paused execution with the matching `executionId`. Narrow and idempotent — anything else no-ops (same part reference), so double-approves and provider replays never clobber a settled result. The part is located by scanning the transcript for the `executionId` (stateless; no parked state to lose).
- **Built-in callables on `Think`**: `approveExecution(executionId)`, `rejectExecution(executionId, reason?)`, `pendingExecutions()`. They delegate to the runtime handle (`this.codemode`, assigned by `createExecuteRuntime(agent)`; re-derived via `getTools()` after a DO restart). Approve runs `runtime.approve()` and applies the outcome through the interaction-apply queue (the same serialized pathway as client tool results), then schedules the auto-continuation. Reject applies `{ status: "rejected", executionId, reason }` so the model adapts instead of erroring.
- **Approval mapping**: `ToolSetConnector` maps AI SDK `needsApproval` to the connector `requiresApproval` — so any `needsApproval` tool handed to the execute tool gets the durable pause/approve/resume flow (including MCP tools). A function-valued `needsApproval` conservatively always requires approval.
- **Pending-args bounding**: a gated call's raw args can be huge (a `writeFile` payload). The transcript/model-facing copy of `pending[].args` is truncated; the facet keeps the full args for the actual resume, and `pendingExecutions()` returns the detail for the card.
- **Client**: the approval card is example code (`examples/assistant`) keyed off execute parts with a paused output; approve/reject buttons call the built-in callables. Stale cards (expired, approved elsewhere) resolve gracefully — `approve` on a non-paused execution returns `{ status: "error" }` and the error outcome reconciles the part.

## Key Decisions

- **Model narrates the pause** rather than silent parking. Costs one turn of latency, but the run explains itself, the turn queue stays simple, and durability is free.
- **Pause-as-tool-output kept** from #1581 — no new protocol message; the card renders from transcript state, so refresh/reconnect/another-device all work.
- **Per-call approval granularity**: approving resumes until the _next_ gated call, which pauses again (same `executionId`, new pending action). The card re-renders.
- Ignoring the card is fine: the turn ended normally; the stale pause eventually expires via `runtime.expirePaused()` (scheduled task).

## Verification

`packages/think/src/tests/execute-hitl.test.ts` drives the full WS path with a mock model: pause → approve → output replaced → continuation sees the result; reject with reason; pause-again; double-approve idempotency; approve after expiry (graceful); approve after the in-memory handle is lost (DO restart path); concurrent paused executions; transcript args truncation vs. full args from `pendingExecutions`. Browser-session-across-pause is covered in the `agents` browser e2e suite.
