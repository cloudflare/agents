# Code Mode Recursive Language Model

The Code Mode RLM is an experimental full-stack example that composes Think,
the Agents SDK, and Code Mode into a durable Recursive Language Model. The
browser provides a chat interface, while the model sees exactly one tool:
`codemode`.

**Status:** experimental example
([`examples/codemode-rlm`](../examples/codemode-rlm)).

Related:

- [Example README](../examples/codemode-rlm/README.md) — setup, API, and usage
- [Research notes](../examples/codemode-rlm/RESEARCH.md) — Prime Agent and RLM
  comparison and fidelity limits
- [Think](./think.md) and
  [durable submissions](./think-durable-submissions.md) — turn lifecycle and
  programmatic admission
- [Agent tools](./agent-tools.md) and
  [sub-agent routing](./sub-agent-routing.md) — child orchestration
- [Code Mode runtime](../docs/codemode/runtime.md),
  [connectors](../docs/codemode/connectors.md), and
  [snippets](../docs/codemode/snippets.md) — durable generated-code execution
- [Visuals](./visuals.md) — Kumo conventions used by the frontend

## Problem

An RLM needs to inspect inputs that are too large to place in every model
request, write programs over that material, preserve useful state, and delegate
bounded semantic work. A durable implementation must also survive hibernation
and retries without repeating child work or accepting unverified assistant
prose as its result.

This repository already has the required primitives, but no single abstraction
combines them. The example demonstrates the composition without adding a new
SDK layer.

## Goals

- Keep full task material outside the active model context.
- Expose only Code Mode to the model while the host controls every durable or
  privileged capability.
- Make root turns and recursive operations recoverable and idempotent.
- Require an environment-backed completion signal before serving an answer.
- Provide a Vite, React, and Kumo chat UI without weakening server admission.
- Keep harness refinement explicit, versioned, auditable, and rollbackable.

## Non-goals

- Reproduce Prime Agent's persistent IPython process or session daemon.
- Claim benchmark parity or automatically evaluated self-improvement.
- Provide production multi-tenancy, authorization roles, cost accounting, or
  retention policy.
- Establish a canonical RLM API in Think, Agents, or Code Mode.

## Architecture overview

```text
Vite + React + Kumo browser
  | authenticated POST admission and GET polling
  v
Worker entry: static assets, authentication, and session API
  |
  v
RLM Think agent
  |-- RLM SQLite store: inputs, kernel, ledgers, harness, answers
  |-- CodemodeRuntime facet
  |     `-- fresh Dynamic Worker with four connector namespaces
  |-- awaited RLM child via runAgentTool
  `-- retained RLM child via subAgent + submitMessages
```

The browser does not use Think's generic chat WebSocket. It submits a stable
`requestId` to the authenticated RLM API and polls the durable request. This
keeps user input on the external-input admission path and ensures the UI only
renders an answer verified by the RLM completion protocol. Think still owns
the underlying model turn, Session, recovery, and child orchestration.

## How it works

### Frontend and request lifecycle

The Vite client renders user and assistant messages plus admitted, running,
completed, and error states. It admits work through
`POST /sessions/:id/think`, polls
`GET /sessions/:id/requests?requestId=...`, and restores the visible
conversation from session history after reload. It uses Kumo components and
semantic tokens and renders assistant Markdown. The bearer token is supplied
at runtime and is never compiled into the client bundle.

### One model-facing tool

Before each turn, the agent creates an explicit Code Mode runtime with the
`context`, `kernel`, `rlm`, and `harness` connectors. It replaces Think's
assembled capability prompt and returns only the canonical `codemode` tool.
`activeTools`, forced tool choice, and `beforeToolCall` provide independent
schema and execution guards.

Generated programs run in fresh Dynamic Workers with `globalOutbound: null`
and without parent workspace, environment bindings, credentials, MCP, browser,
or fetch tools. Standard Worker and Node-compat ambient APIs may still exist,
including an ephemeral sandbox filesystem. Durable or privileged effects must
cross a connector.

### Context, kernel, and completion

Task material is chunked into the agent's SQLite store. The prompt receives a
compact pointer and preview; `context.*` exposes bounded metadata, slices,
literal search, transcript records, and execution summaries. Queued inputs
become connector-visible only when their own turn starts, so an earlier turn
cannot inspect a later submission.

`kernel.*` stores JSON-serializable notebook values across executions and
turns. It does not preserve closures, imports, open resources, or a JavaScript
heap. `kernel.finish({ content })` records a candidate answer. The host serves
it only when its Code Mode execution completed and the execution ledger binds
it to the same agent, input, and turn mode.

### Recursion and recovery

`rlm.query` runs one awaited child through idempotent `runAgentTool`.
`rlm.spawn` admits work to a named, retained Think child, and `rlm.followup`
uses that child's durable `submitMessages` queue. Retained children own their
Session, external inputs, kernel, transcript, Code Mode facet, and recovery
state. Recursion defaults to depth one.

Each recursive mutation has a caller key. Its durable identity combines the
active input, operation kind, child where applicable, and that key; a separate
argument hash rejects changed data. Budgets are charged once per logical
operation, independent of Code Mode execution IDs.

A root `requestId` similarly maps to stable input and Think submission IDs.
Retries with changed arguments are rejected, and polling repairs the narrow
case where the request ledger committed before Think admission. Conditional
updates protect child heads and terminal results; duplicate completion
reconciles the parent projection instead of rerunning work.

### Continual harness

The harness holds versioned prompt, memory, skill, and sub-agent supplements.
Normal turns can read it; only explicit refinement turns can mutate it. Writes
use optimistic revisions, retain audit snapshots, and support rollback. The
base prompt is immutable, and executable skills can only reference snippets a
developer promoted from successful Code Mode executions. An expected outcome
is a hypothesis, not proof that a revision improved the agent.

### Durable state ownership

| Owner                      | Durable state                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| Think and Agents framework | Session messages, submissions, child facets, and agent-tool runs                                      |
| RLM store in each agent    | Inputs, activation, transcript, kernel, request and operation ledgers, harness, and answer projection |
| Code Mode runtime facet    | Execution call logs, replay state, terminal status, and snippet bodies                                |
| Browser                    | Presentation state, caller-generated request identifiers, and a per-tab bearer token                  |

The RLM store exposes bounded execution summaries to the model; the Code Mode
facet remains the source of truth for complete runtime audit records.

### Security boundary

Every session route requires the configured bearer token; session names are
routing keys, not credentials. The generic Think WebSocket is not exposed
because it would bypass external-input admission and could accept
client-provided tools. The same token authorizes tasks and administrative
refinement, rollback, and snippet routes, which makes this a single-operator
example. Production needs tenant authorization and separate control-plane
roles. The generated Dynamic Worker never receives the token.

## Invariants to preserve

- `codemode` is the only tool visible to or executable by the model.
- Full external material is connector-addressable, not copied into messages.
- An input becomes connector-visible only when its queued turn is active.
- A returned answer comes from `kernel.finish` and a matching completed Code
  Mode execution.
- Stable logical operation IDs govern recursive idempotency and budget charges.
- Late work cannot overwrite terminal request, operation, or child states.
- Harness writes require explicit refinement and revision checks; the base
  prompt remains immutable.
- Session and administrative routes authenticate before resolving an agent,
  and the frontend never bundles the server secret.

## Key decisions

- **Use a chat UI over POST and polling.** This preserves custom admission and
  verified completion, at the cost of token-by-token assistant streaming.
- **Compose existing durable primitives.** Think owns turns, Agents owns child
  facets and agent-tool runs, and Code Mode owns generated-code replay.
- **Use an explicit JSON kernel.** Fresh Workers cannot honestly provide a
  persistent interpreter heap; serializable state makes the boundary clear.
- **Separate awaited queries from retained children.** One terminal result and
  a follow-up-capable child have different lifecycle contracts.
- **Guard refinement.** Immutable base behavior, curated snippets, revision
  checks, and rollback are safer than model-controlled source modification.

## Tradeoffs and limitations

- Polling is recovery-friendly but does not stream intermediate tokens.
- History reloads are bounded to the latest 50 messages and currently use
  truncated transcript content; the terminal poll carries the complete current
  answer.
- The JSON kernel cannot reproduce a persistent interpreter process.
- Awaited queries run complete child agents and are heavier than leaf calls.
- Input search is literal rather than semantic.
- Harness revisions have no automatic evaluator or staged rollout.
- Retention, aggregate token/cost budgets, and multi-tenant authorization remain
  production work.

## Testing

Pure tests cover identifiers and harness editing. Worker-pool tests cover the
SQLite store, causal activation, operation claims, child projection CAS,
terminal protection, snippet reservation, and recovery reconciliation. The
full example is also typechecked, built with Vite, and verified with a Wrangler
deployment dry run.
