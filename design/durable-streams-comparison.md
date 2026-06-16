# Durable Streams vs the Agents SDK

An analysis of [Durable Streams](https://github.com/durable-streams/durable-streams)
([durablestreams.com](https://durablestreams.com), [PROTOCOL.md](https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md))
and how it relates to the streaming and recovery layers of this repo.

Durable Streams is an [ElectricSQL](https://electric-sql.com/) project, MIT-licensed,
marketed as "the data primitive for the agent loop." It grew out of ~1.5 years of
production Postgres sync at Electric and is now repositioned toward the AI/agents
market — the same market we serve.

Related:

- [chat-shared-layer.md](./chat-shared-layer.md) — our streaming/protocol primitives in `agents/chat`
- [rfc-chat-recovery-foundation.md](./rfc-chat-recovery-foundation.md) — our turn-recovery policy layer
- [rfc-workers-ai-gateway-merge.md](./rfc-workers-ai-gateway-merge.md) — provider-level stream resume

---

## TL;DR

Durable Streams and the Agents SDK are **not competitors in the same layer**.
Durable Streams is a **data/transport primitive** (durable, offset-addressed,
append-only byte streams over HTTP). The Agents SDK is a **stateful compute
runtime** that, among many other things, has its own streaming layer.

> They store and replay a stream. We run the thing that produces it — colocated
> with state, tools, scheduling, and the client connection.

Durable Streams could plausibly sit **underneath** our streaming layer as a
substrate (gaining CDN fan-out and forking). It can never **substitute** for the
agent runtime.

---

## What Durable Streams is

Three artifacts in one repo:

1. **A protocol** — a v1.0 draft spec, even requesting an IANA port (4437) and HTTP
   header registrations. This is the real bet: a standard, not just a library.
2. **Clients in 10 languages** — TS, Python, Go, Elixir, .NET, Swift, PHP, Java,
   Rust, Ruby.
3. **Servers + higher-level abstractions** — Caddy plugin (production), Node
   reference server, plus `Durable Proxy` (AI token streams), `Durable State`,
   `StreamDB`, `StreamFS`, and integrations for Vercel AI SDK / TanStack AI /
   AnyCable.

### Protocol essence

A stream **is a URL**, operated on with plain HTTP:

- `PUT` create (or **fork**), `POST` append (or close), `GET ?offset=…` read.
- Three read modes: **catch-up**, **long-poll**, **SSE** live tail. `HEAD` for
  metadata, `DELETE` (with soft-delete + refcount GC for forks).
- **Offset resumability** — opaque, lexicographically-sortable offsets; clients
  persist the last offset and resume from exactly there.
- **Explicit EOF** — durable, monotonic stream closure distinguishes "no data yet"
  from "no more data ever."
- **Exactly-once writes** — Kafka-style idempotent producers
  (`Producer-Id` + `Producer-Epoch` + `Producer-Seq`, with zombie epoch fencing).
- **Forking** — cheap branch-from-offset (copy-on-fork / pointer stitching).
- **CDN-native fan-out** — cursor-based request collapsing so one origin serves
  millions of concurrent viewers; SSE connections recycle ~60s to re-collapse.
- **Subscriptions** — durable cursors that wake workers via signed webhook or
  pull-wake, with generation fencing and leases.
- **JSON mode** preserves message boundaries; otherwise content-type-agnostic bytes.

---

## How it maps onto what we already have

Large parts of the protocol map almost 1:1 onto bespoke code we built **inside the
Durable Object**:

| Durable Streams concept                      | Our equivalent                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Offset-based catch-up + replay               | `ResumableStream` chunk buffer/replay in DO SQLite (`packages/agents/src/chat/resumable-stream.ts`) |
| Live SSE / long-poll tailing                 | WebSocket live tail + resume handshake (`packages/agents/src/chat/protocol.ts`)                     |
| `Stream-Closed` / EOF                        | Stream completion + terminal frame / `COMPLETED_RETENTION_MS` grace window                          |
| Idempotent producers (id/epoch/seq, fencing) | Recovery incident identity + `cf-aig-run-id`/epoch fencing (gateway-merge RFC)                      |
| Subscriptions: generation fencing + leases   | Fiber recovery + alarm scheduling + incident generation/lease semantics                             |
| "Durable Proxy for AI token streams"         | Exactly the gateway-resume RFC: persist upstream LLM SSE so a client resumes by offset              |
| Stream forking from an offset                | **No clean equivalent** — closest is `continueLastTurn` / conversation branching, ad hoc            |

The crucial framing: **Durable Streams is the lower rung; our chat-recovery
foundation is the upper rung.** Their protocol deliberately stops at bytes +
offsets + EOF + fan-out. It does not do turn orchestration, incident budgets,
retry-vs-continue, HITL parking, or provider-aware resume — the policy layer our
`ChatRecoveryEngine` owns. They independently validate the exact seam the recovery
RFC draws: a resumable-stream _primitive_ separated from a recovery _policy_. Their
content-type-agnostic byte stream + JSON mode also mirrors our `ChatRecoveryCodec`
(harness-agnostic format seam).

---

## What we have that they don't

The headline difference: **Durable Streams has no compute model.** It persists
streams produced _somewhere else_. That single fact cascades into most of this list.

1. **Colocated stateful compute.** An agent is a live DO with methods, RPC,
   `this.setState`, SQL, and KV — code executing next to its own data. Because the
   stream buffer, message transcript, and agent state share one DO SQLite, we update
   all three **transactionally**. A separate stream store can't give that.
2. **Durable turn orchestration / recovery policy.** Incident budgets,
   retry-vs-continue, terminalization, stall watchdog, HITL parking, fiber recovery
   on DO wake. Their protocol explicitly punts on all of it.
3. **Durable execution + scheduling.** `runFiber` (survives eviction), alarms, and
   `this.schedule()`. Their subscriptions can _wake_ your worker, but the worker and
   its durability are still your problem.
4. **Full-duplex, hibernatable WebSockets.** Client→agent input and agent→client
   output over one bidirectional, hibernating connection. Durable Streams is HTTP
   append + one-directional read; interactive input needs a _second_ stream and your
   own correlation.
5. **Tools, HITL, MCP, workflows.** Tool calling, human-in-the-loop confirmation,
   full MCP server **and** client (`agents/mcp`), workflow patterns.
6. **Provider-aware model integration.** Workers AI binding, AI Gateway, and resume
   that feeds bytes back _through the provider parser_. Their "Durable Proxy" is
   provider-blind — it replays bytes without understanding the model stream.
7. **Multimodal agent surfaces.** Browser/computer use (`packages/agents/src/browser`),
   email, voice.
8. **Sandboxed code execution.** `@cloudflare/codemode` + `@cloudflare/shell`
   (dynamic Worker loader, sandboxed JS/filesystem).
9. **Client framework + routing.** `useAgent`/`useAgentChat` React hooks,
   `partysocket` reconnection, `routeAgentRequest` per-conversation DO addressing.

---

## What they have that we don't

All three are _within_ the transport layer — the strengths of being a thin,
edge-cacheable data primitive rather than a stateful object:

- **CDN fan-out.** Cursor-collapsing serves millions of concurrent viewers per
  stream. A single DO is a fan-out bottleneck; broad read fan-out is not our sweet
  spot today.
- **Stream forking.** Cheap branch-from-offset — directly useful for conversation
  branching and sub-agent forks, which we currently do ad hoc.
- **Client reach.** 10 languages and a protocol-standardization push vs our
  TS-centric framework.

---

## Strategic takeaways

1. **Competitive signal.** A serious team is targeting our exact audience (AI/agents
   streaming) with AI-SDK and TanStack integrations and a standardization push.
   Worth tracking.
2. **Validation.** Their architecture is strong external evidence that the
   recovery RFC's core split — resumable-stream primitive vs recovery policy — is
   right.
3. **Learn-from list.** Forking, idempotent-producer fencing, and CDN cursor
   collapsing are cleaner than our DO-internal ad hoc handling of the same concerns.
4. **Interop opportunity.** Cloudflare is a near-ideal backend for this protocol
   (DOs for ordering/closure, R2 for chunk storage keyed by opaque offset, Cache for
   collapsing). A CF-native Durable Streams _server_, or making our
   resumable-stream/codec seam able to sit on a Durable-Streams-compatible
   transport, is a plausible future direction — especially as the genericity /
   "pi harness" goal in the recovery RFC pushes us toward a transport-agnostic
   stream layer.

The open question is not "who wins." It is whether our resumable-stream / codec
seam should be able to sit on top of a Durable-Streams-style transport to pick up
fan-out and forking for free, while keeping the agent runtime — state, tools,
recovery policy — firmly ours.
