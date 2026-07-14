# Infrastructure

Behavior-free contracts for the capabilities the domain needs from the outside
world, plus their implementations. This is the hexagonal boundary — the
anti-corruption layer to Cloudflare Durable Objects and the AI SDK. The glossary
covers `src/ports/` (the contracts) and `src/adapters/` (the implementations: the
in-memory/fake set plus production-shaped adapters such as Anthropic and node).
See the [context map](../../CONTEXT-MAP.md).

## Boundary

**Port**:
An interface-only abstraction of an external capability; the sole surface the
domain is allowed to see.
_Avoid_: interface, binding

**Adapter**:
A concrete implementation of a port. The in-memory set is the reference/test
implementation; production-shaped adapters exist too (Anthropic model, node
file-store/real-time, websocket-chat transport). Cloudflare Durable Object adapters
are still future work.

**MemoryHost**:
The fully-assembled in-memory port set the composition roots consume in tests and
e2e.

## Storage & time

**Clock**:
A port exposing the current time in epoch milliseconds. Domain code never calls
the wall clock directly.
_Avoid_: Date.now, timer

**KeyValueStore**:
A synchronous, ordered, prefix-scannable, JSON-valued storage port — the semantics
a Durable Object gives you.
_Avoid_: storage, KV, ctx.storage, database

**Scoped store**:
A KeyValueStore view that prepends a module's prefix on write and strips it on
read, giving a module "its own" storage without seeing siblings.

**Key prefix**:
The per-module string (e.g. `fiber:`, `subm:`) that partitions the shared store.
No module reads another's prefix.
_Avoid_: namespace, table

## Durable-object substrate

**AlarmTimer**:
A port for the single Durable Object alarm slot: setting it replaces any previous
alarm. Multiplexed by the Scheduler.
_Avoid_: alarm slot, setAlarm

**Connection**:
A port abstraction of one client transport surface with an id, `send`, `close`,
and a per-connection attachment bag.
_Avoid_: WebSocket, partyserver Connection, socket

**ConnectionRegistry**:
A port over the live connections supporting iteration, lookup, and broadcast with
exclusions.

## Model

**ModelClient**:
The domain's minimal streaming LLM contract: given a request, yields a stream of
chunks. Deliberately independent of the AI SDK.
_Avoid_: the LLM, streamText, the model API

**ModelRequest**:
The input handed to a ModelClient: system prompt, messages, tool descriptors, tool
choice, settings, abort signal.

**ModelChunk**:
A typed unit streamed *from* the model: text-delta, reasoning-delta, tool-call, or
finish.
_Avoid_: chunk, delta — the client-facing streamed unit is a **UiChunk** (Turn).

**ToolDescriptor**:
A tool's advertised shape (name, description, JSON schema) with no executor — what
the model is *told* about a tool.

**FakeModel**:
The scripted ModelClient test double, driven by a list of scripted turns and
capturing the requests it receives.

## External capabilities (ports only; engines out of scope)

**Sandbox**:
A port for out-of-scope code-execution engines (js/ts/python/bash).

**EmailTransport**:
A port that sends an email message and returns a message id.

**WorkflowRuntime**:
A port abstracting Cloudflare Workflows lifecycle operations.

**ExternalToolSource**:
A port for external tool providers (MCP and friends): ready / list / call.
_Avoid_: MCP (that's one provider)

**AgentSpawner**:
A port that lazily gets a handle to a named child agent instance.
_Avoid_: facet spawner, ctx.exports

**AgentHandle**:
A handle to a child agent instance supporting call, abort (keep storage), and
destroy (wipe storage).
_Avoid_: facet

**FetchLike**:
The outbound-fetch port backing the fetch tool and service bindings.
