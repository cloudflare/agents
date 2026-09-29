# Agent-backed A2A server

This server-only example runs two [A2A 1.0](https://a2a-protocol.org/) endpoints on one Cloudflare Worker, with durable tasks owned by Agents and execution owned by Agent Workflows.

The deterministic demo needs no model API key. A Coordinator drafts an answer, discovers the Specialist's Agent Card, talks to it over A2A HTTP/JSON-RPC, answers one `INPUT_REQUIRED` continuation, and returns their joint result.

## Architecture

```text
A2A client
  -> /coordinator/a2a
  -> CoordinatorAgent (16 owner-scoped, context-hashed Agent DO shards)
  -> CoordinatorWorkflow extends AgentWorkflow
  -> /specialist/a2a (same Worker, real Request/Response routing)
  -> SpecialistAgent + SpecialistWorkflow
  -> INPUT_REQUIRED -> continuation -> COMPLETED
  -> streamed Coordinator artifacts and final task
```

`createA2AContextDO(...)` is the reusable protocol adapter. It extends `Agent`, stores an authenticated owner's A2A tasks and replayable events across 16 context-hashed Agent shards, and launches Workflows through inherited `runWorkflow`, `getWorkflow`, `getWorkflowStatus`, and `terminateWorkflow` APIs. Unfiltered `ListTasks` requests fan out across those bounded shards and merge cursor pages by status timestamp. Each turn gets a stable, fixed-length Workflow ID derived from the task's server-issued nonce.

Both concrete workflows extend `AgentWorkflow` and update their originating task through `this.agent`. The Coordinator does not call the Specialist through direct Agent RPC; `src/a2a-client.ts` performs Agent Card discovery and bounded A2A HTTP/JSON-RPC calls through the same Worker router.

## Endpoints

| Agent       | Public Agent Card                          | Bearer-authenticated JSON-RPC |
| ----------- | ------------------------------------------ | ----------------------------- |
| Coordinator | `/coordinator/.well-known/agent-card.json` | `/coordinator/a2a`            |
| Specialist  | `/specialist/.well-known/agent-card.json`  | `/specialist/a2a`             |

The runtime supports `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, and `SubscribeToTask`. All seven optional capabilities are disabled by default in the reusable runtime and explicitly enabled by this example: blocking send, streaming, task listing, cancellation, multi-turn tasks, intermediate artifacts, and completion artifacts.

## Run Locally

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm run types
pnpm run dev
```

In another terminal, use the same token from `.dev.vars`:

```bash
export A2A_BEARER_TOKEN=replace-with-a-long-random-token
pnpm run demo -- "How should we roll out this change?"
```

The CLI discovers both cards, starts a streaming Coordinator task, prints status and artifact events, then prints the Coordinator and Specialist task IDs plus the continuation request and response. Pass a different origin if needed:

```bash
pnpm run demo -- --origin http://localhost:8787 "How should we roll out this change?"
```

## Security And Limits

- Agent Cards are public; both JSON-RPC endpoints require the same bearer token.
- Requests must send `A2A-Version: 1.0`; an absent or empty version retains the protocol-defined `0.3` meaning and is rejected by these 1.0-only cards.
- This single-owner example rejects non-empty A2A `tenant` parameters instead of silently ignoring them.
- Bearer tokens are compared with fixed-size SHA-256 hashes and `timingSafeEqual`.
- Configure local secrets in `.dev.vars`; configure deployed secrets with `wrangler secret put A2A_BEARER_TOKEN`.
- JSON bodies, text parts, Workflow payloads, SSE events, replay batches, task growth, and list responses have explicit bounds.
- JSON-RPC request IDs are required, non-null, and limited to 256 UTF-8 bytes. Message IDs provide context-scoped task idempotency; conflicting replays are rejected.
- Stopped-task events and terminal Workflow tracking are retained for 24 hours. Final tasks and all task-owned rows default to 30-day retention, configurable with `terminalTaskRetentionMilliseconds`.
- Recovery terminalizes pending tasks after the Agent alarm memory-limit retry budget is exhausted and preserves exhausted cancellation callbacks as dead letters. Pagination cursors, task ownership, cancellation races, and stale Workflow callbacks are handled by the runtime.
- The internal A2A client has a deadline, event and byte ceilings, bounded resubscription, and one final `GetTask` fallback.

## Test

```bash
pnpm run typecheck
pnpm run test:node
pnpm run test:workerd
```

The Node suite covers protocol behavior and hardening boundaries. The workerd suite uses the real Agent DO and Agent Workflow bindings to verify sharded routing and listing, authentication, Specialist continuation, and the complete Coordinator-to-Specialist exchange.

## Key Files

- `src/runtime/context-do.ts`: reusable Agent-backed A2A shard factory
- `src/runtime/task-store.ts`: durable tasks, events, recovery, retention, and idempotency
- `src/workflow.ts`: Coordinator and Specialist `AgentWorkflow` implementations
- `src/a2a-client.ts`: bounded Agent Card discovery, streaming, replay, and continuation client
- `src/router.ts`: the four public routes
- `demo.ts`: terminal client for the complete interaction
