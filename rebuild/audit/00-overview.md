# Clean-Room Rebuild: Think + Agent — Architecture Overview

This directory is the **complete specification** for a clean-room rebuild of two god
classes from the Cloudflare Agents SDK: `Agent` (a supercharged Durable Object base
class, ~13k lines) and `Think` (an opinionated chat-agent harness built on it,
~15k lines). Implementers work **only** from these audit documents and from code
already written under `rebuild/src/`. Do not read `packages/think/` or
`packages/agents/` — that is the point of the clean room.

## Why the rebuild

The original system concentrates ~28k lines in two classes. Every feature —
scheduling, durable execution, chat streaming, approvals, submissions, skills,
channels — is a method cluster on one of the two classes, sharing private state
and a single SQLite namespace. The rebuild applies the dependency rule from
clean architecture: **source-code dependencies point inward**, from adapters to
application to domain to kernel, never outward. Frameworks (Durable Objects, the
AI SDK, WebSockets) are details that live at the edge behind ports.

## Layering

```
rebuild/src/
  kernel/     Pure utilities. No I/O, no ports, no domain knowledge.
  ports/      Interfaces only. The domain's view of the outside world.
  domain/     One service per responsibility. Pure TS over ports. All business rules.
  app/        Agent + Think: thin composition roots wiring domain services together.
  adapters/   In-memory implementations of every port (tests + e2e), plus a place
              for future Cloudflare adapters (real DO storage/alarms/websockets).
```

Rules:

1. `kernel` imports nothing from the other layers.
2. `ports` imports only `kernel`.
3. `domain` imports `kernel` and `ports`. A domain module may import other domain
   modules only where this overview's dependency graph says so.
4. `app` imports anything except `adapters`.
5. `adapters` may import anything.
6. **No runtime dependency on the AI SDK, Durable Objects, or partyserver.** We
   define our own message model and model-client port; production adapters can
   map to the AI SDK later.
7. Runtime deps: only `zod` (tool input schemas). Dev deps: vitest + typescript.

## Module inventory and build order

Modules are grouped in dependency waves. Everything in a wave depends only on
earlier waves (and siblings where noted). Each module has a section in the
numbered audit file listed.

| #   | Module                      | Path                          | Audit doc | Wave |
| --- | --------------------------- | ----------------------------- | --------- | ---- |
| 1   | ids & hashing               | `kernel/ids.ts`               | 01        | 0    |
| 2   | error taxonomy              | `kernel/errors.ts`            | 01        | 0    |
| 3   | JSON utilities              | `kernel/json.ts`              | 01        | 0    |
| 4   | observability event bus     | `kernel/events.ts`            | 01        | 0    |
| 5   | ports (all)                 | `ports/*.ts`                  | 02        | 0    |
| 6   | in-memory adapters          | `adapters/memory/*.ts`        | 02        | 1    |
| 7   | message model               | `domain/messages/model.ts`    | 03        | 1    |
| 8   | sanitization & repair       | `domain/messages/repair.ts`   | 03        | 2    |
| 9   | message store               | `domain/messages/store.ts`    | 03        | 2    |
| 10  | state container             | `domain/state/state.ts`       | 04        | 2    |
| 11  | schedule DSL                | `domain/scheduling/dsl.ts`    | 05        | 2    |
| 12  | cron subset parser          | `domain/scheduling/cron.ts`   | 05        | 2    |
| 13  | scheduler                   | `domain/scheduling/scheduler.ts` | 05     | 3    |
| 14  | keep-alive                  | `domain/scheduling/keep-alive.ts` | 05    | 3    |
| 15  | task queue                  | `domain/queue/queue.ts`       | 04        | 3    |
| 16  | fibers (durable execution)  | `domain/fibers/fibers.ts`     | 06        | 3    |
| 17  | stream model & accumulator  | `domain/stream/chunks.ts`     | 07        | 2    |
| 18  | resumable stream buffer     | `domain/stream/resumable.ts`  | 07        | 3    |
| 19  | tool registry & wrapping    | `domain/tools/registry.ts`    | 08        | 3    |
| 20  | turn loop engine            | `domain/turn/loop.ts`         | 09        | 4    |
| 21  | turn admission queue        | `domain/turn/admission.ts`    | 09        | 3    |
| 22  | session & context blocks    | `domain/session/session.ts`   | 10        | 3    |
| 23  | compaction                  | `domain/session/compaction.ts`| 10        | 4    |
| 24  | submissions ledger          | `domain/submissions/submissions.ts` | 11  | 4    |
| 25  | actions                     | `domain/actions/actions.ts`   | 12        | 4    |
| 26  | declared scheduled tasks    | `domain/scheduled-tasks/tasks.ts` | 13    | 4    |
| 27  | chat recovery               | `domain/recovery/recovery.ts` | 14        | 4    |
| 28  | context-overflow guard      | `domain/recovery/overflow.ts` | 14        | 4    |
| 29  | workspace (virtual FS)      | `domain/workspace/workspace.ts` | 15      | 3    |
| 30  | workspace tools             | `domain/workspace/tools.ts`   | 15        | 4    |
| 31  | fetch tool                  | `domain/fetch/fetch-tool.ts`  | 16        | 3    |
| 32  | skills                      | `domain/skills/skills.ts`     | 17        | 4    |
| 33  | channels & notices          | `domain/channels/channels.ts` | 18        | 4    |
| 34  | agent-tool runs (delegation)| `domain/delegation/runs.ts`   | 19        | 4    |
| 35  | workflow tracking           | `domain/workflows/workflows.ts` | 20      | 4    |
| 36  | callable registry (RPC)     | `domain/rpc/callable.ts`      | 21        | 3    |
| 37  | Agent composition           | `app/agent.ts`                | 22        | 5    |
| 38  | Think composition           | `app/think.ts`                | 23        | 5    |
| 39  | scripted fake model         | `adapters/memory/fake-model.ts` | 02      | 1    |
| 40  | e2e scenarios               | `src/e2e/*.test.ts`           | 24        | 6    |

### Explicitly out of scope (ported as ports/stubs only)

- **MCP client internals** (OAuth, transports, discovery): the `McpToolSource`
  port lets Think merge external tools; a real MCP client is future work.
- **Messenger providers** (Telegram/Chat SDK): the `Messenger` port + channels
  module carry the concept; provider adapters are future work.
- **Sandboxed extensions / codemode execute / browser tools**: behind the
  `Sandbox` port; the LLM-facing tool wiring is speced in doc 08.
- **Email transport**: behind the `EmailTransport` port (doc 02); routing
  resolvers and inbound parsing are future work.
- **Cloudflare Workflows engine**: behind the `WorkflowRuntime` port; the
  domain tracking table IS in scope (doc 20).
- **React client, Vite plugin, framework codegen, voice**: out of scope.
- **Postgres session provider**: the session storage port has one in-memory
  implementation here; SQLite/Postgres adapters are future work.

## Cross-cutting conventions

- **Persistence** goes through the `KeyValueStore` port (doc 02): synchronous,
  prefix-scannable, JSON values — the semantics a Durable Object gives you.
  Each domain module owns a key prefix, e.g. `schedule:`, `fiber:`, `subm:`.
  No module reads another module's prefix.
- **Time** comes from the `Clock` port. Never call `Date.now()` in domain code.
- **Randomness/ids**: use `kernel/ids`. Deterministic ids are injectable for tests.
- **Events**: every significant operation emits a typed event on the
  `EventBus` (doc 01). Event names use the original vocabulary
  (`schedule:execute`, `fiber:recovery:handled`, `chat:recovery:exhausted`...)
  so downstream tooling maps over.
- **Errors**: throw typed errors from `kernel/errors`; tool/action failures are
  *values* (structured `{ error: { name, message } }` results), not exceptions
  that cross the turn loop.
- **Testing**: TDD. Write the test file first, then the implementation. Every
  module ships `*.test.ts` colocated. Tests use only in-memory adapters. Aim
  for behavior-level tests (the spec bullets in each audit doc are the test
  list) rather than implementation-detail tests.
- **Wire compatibility is NOT a goal**, but keep the *names* of client-visible
  message types (`cf_agent_*`, doc 23) and event types so the concepts map.

## Status tracking

`rebuild/PROGRESS.md` records which modules are implemented, tested, and
integrated. Update it when a module lands.
