# Issues

Lightweight local tracker for known gaps and deferred work surfaced while building
and domain-modeling the clean-room rebuild. Just enough to not lose the thread —
not a replacement for a real tracker. Resolve or delete entries as they're
addressed.

Use this for *gaps to fix later*. Decisions we're happy to stand behind go in
[`docs/adr/`](./docs/adr/) instead.

**Status:** `open` · `in-progress` · `resolved`

---

## ISSUE-001 — Reasoning is output-only; not replayable to providers that support it

**Status:** open · **Area:** Conversation + Infrastructure (`ModelMessage` port)

The `ModelMessage` port carries reasoning on the way *out* (`ModelChunk`
`reasoning-delta`) but has no reasoning variant on the way *in* — assistant
`content` is `text | tool-call` only. So `toModelMessages` drops reasoning, and no
adapter can resend it. This bakes a provider assumption — "no provider accepts
reasoning back" — into the domain contract, which is **false**: Anthropic
(interleaved thinking, signed) and OpenAI (reasoning items) replay reasoning in
multi-step tool flows.

Reasoning is still persisted on the `ChatMessage` and streamed to clients; only
*provider replay* is missing.

This is also a real gap in the original Think implementation, though the failure
mode is narrower there. Original Think routes assistant reasoning through the AI
SDK's `convertToModelMessages`, which can replay reasoning when the persisted
part still contains the provider metadata. However, its persistence sanitization
strips OpenAI's ephemeral `reasoningEncryptedContent` (and `itemId`) before the
message is stored. A later turn therefore cannot faithfully replay OpenAI
reasoning, even though the in-memory conversion path supports reasoning content.
The rebuild currently regresses this further by dropping all reasoning at the
domain `ModelMessage` boundary, regardless of provider.

Correct handling (deferred):
- Add a reasoning variant to assistant `ModelMessage` content, carrying the
  provider's opaque/signed payload — not just display text (today's reasoning part
  is `{ type: "reasoning"; text }`, insufficient for faithful replay).
- Capture that payload at generation time.
- Move the drop/keep decision into the per-provider adapters (filter if
  unsupported) rather than dropping unconditionally in the domain.

Not an ADR: this is a gap to fix, not a decision to enshrine.

---

## ISSUE-002 — Channels hard-codes an implicit "web" channel

**Status:** resolved · **Area:** Channels (`src/domain/channels/`)

Dropped `IMPLICIT_WEB` and the `kind === "web"` special case. The transcript is now
the default delivery sink; `web` is just a normal (optional) channel; a channel with
no `deliver` hook falls back to the transcript (the uniform sub-choice, replacing the
old out-of-turn throw). Channels glossary DRAFT lifted.

---

## ISSUE-003 — Consume the MCP client stack behind `ExternalToolSource`

**Status:** open · **Area:** Integration ([audit 28](./audit/28-reuse-vs-reimplement.md) Tier 2 #1)

The original's MCP client (`agents/src/mcp/` minus the `McpAgent` server class,
~6.9k LOC: transports, OAuth provider, x402, connection lifecycle) imports nothing
from Agent — its only internal dep is the standalone `core/events` util. The
rebuild's `ExternalToolSource` port is the reserved seam and is currently
unimplemented. Vendor the client + `core/events`, write a thin adapter mapping
`ready/listTools/callTool` onto it. Highest-value consumption: fills a real gap
with zero re-implementation. (The `McpAgent` *server* half extends Agent and is
explicitly NOT consumed — re-implement on the shell if wanted.)

---

## ISSUE-004 — Consume `@cloudflare/codemode` behind the `Sandbox` port

**Status:** open · **Area:** Integration (audit 28 Tier 1)

Zero coupling to Agent/Think (verified); needs only a `DurableObjectState`, which
the DO shell has. Take it as a plain npm dependency. Two seams: a `Sandbox` port
adapter (`ports/sandbox.ts` is reserved and unimplemented), and/or a codemode tool
provider (its raw-JSON-schema `ConnectorTool` shape matches our tool shape).
Prerequisite for ISSUE-005 and for the original skills runner as an alternative
`SkillSource` backend.

---

## ISSUE-005 — Consume `@cloudflare/shell` as a workspace adapter

**Status:** open · **Area:** Integration (audit 28 Tier 1)

Zero runtime coupling to Agent/Think (only its test fixtures import `agents`);
plugs into codemode via `StateConnector`, needs a `StateBackend` + DO state. Do
NOT swap tool layers wholesale: keep `domain/workspace` as the port and add a
shell-backed adapter implementing it, which brings the richer capabilities
(git via isomorphic-git, bash) behind our existing seam. Depends on ISSUE-004.

---

## ISSUE-006 — Consume the `think/extensions/` plugin seam

**Status:** open · **Area:** Integration (audit 28 Tier 2 #2)

The designed plugin seam is genuinely clean: `ExtensionManager` takes a pure
options object (`WorkerLoader`, storage, `createHostBinding`); extensions are
sandboxed Workers with a manifest/permissions contract; the host implements a
fixed 9-method `_host*` bridge (read/write/delete/list files, get/set context,
get messages, send message, session info). Lift the manager + host bridge,
implement the 9 methods over rebuilt Think (workspace + session + context
blocks), wire `WorkerLoader` in the Cloudflare shell. The host-bridge's
parent-DO resolution (class-name + id) needs adapting to the shell's identity
scheme. New capability — no overlap with existing modules. `worker-bundler`
becomes relevant here (dev-time bundling for extension workers).

---

## ISSUE-007 — Consume the existing browser/React client as-is (compat smoke test)

**Status:** open · **Area:** Integration (audit 28 Tier 2 #3)

`agents/src/client.ts` + `react.tsx` couple to the core by types only — they
depend on the `cf_agent_*` protocol vocabulary (`MessageType` enum) we
deliberately preserved. Consumption here means *proving* the existing published
client works unmodified against the rebuild's WS adapter + shell: the deferred
`agents/react` smoke test (drive `useAgent`/`useChat` at a workerd-hosted rebuilt
Think). Also the forcing function for ISSUE-008-adjacent gaps: client-supplied
message-array reconciliation (audit 28 appendix #2) will surface here.

---

## ISSUE-008 — Consume `agents/src/browser/` (CDP browser automation tools)

**Status:** open · **Area:** Integration (audit 28 Tier 2 #4)

~3.1k LOC, exactly one coupling line: an optional `agentContext` ALS fallback to
reach `agent.ctx`, already bypassed by passing `ctx` in `CreateBrowserToolsOptions`.
Vendor it, drop the ALS fallback, expose through our tool shape (its AI-SDK-entry
tools convert cheaply now that adapters have `ai` v6). Needs the Browser
Rendering binding in the shell/demo wrangler config.

---

## ISSUE-009 — Consume the `observability/` interface as an EventBus adapter

**Status:** open · **Area:** Integration (audit 28 Tier 2 #5)

Pure `emit(event)` interface + `node:diagnostics_channel` fan-out, zero Agent
coupling. Cheap adapter bridging our kernel `EventBus` onto its named channels
(`agents:state|rpc|message|chat|transcript`) so existing observability consumers
work against the rebuild. Low effort; do whenever standardized observability is
wanted.

---

## ISSUE-010 — Consume `@cloudflare/voice` via a shell-level facade

**Status:** open · **Area:** Integration (audit 28 Tier 1)

`withVoice(Base)` is a mixin needing only `Pick<Agent, "sql" | "getConnections" |
"keepAlive">` + `onConnect`/`onMessage` override points and `Connection`/`WSMessage`
types; it runs its own `voice_*` WS protocol (not `cf_agent_*`). Voice is
transport-adjacent, so in the rebuild it belongs at the SHELL: a compatibility
facade exposing `sql` (real DOs have `ctx.storage.sql`), `getConnections` (durable
connection registry), `keepAlive` (Agent's keep-alive service), and
connect/message hooks. Moderate glue, architecturally consistent — the agent
class stays transport-free.

---

## ISSUE-011 — Consume `think/messengers/` (+ `channels/` glue)

**Status:** open · **Area:** Integration (audit 28 Tier 2 #6)

Decoupled behind its self-defined `MessengerThinkHost` interface (fibers +
sub-agents + `StreamCallback`), all of which the rebuild has. Lift when a real
messenger surface (Telegram etc.) is needed: implement `MessengerThinkHost` over
rebuilt Think, keep `channels/index.ts` as the typed glue. Watch the
`StreamCallback`/`ChatStartEvent` shapes (ours are structurally compatible) and
its `RpcTarget` (Workers RPC) assumption.

---

## ISSUE-012 — Consume `hono-agents` (router type shim)

**Status:** open · **Area:** Integration (audit 28 Tier 1)

86 lines; couples to exactly two symbols: `routeAgentRequest` (our Cloudflare
`routing.ts` already matches the shape — Response with `webSocket`) and the
`AgentOptions` type. Either publish a compatible type + re-point the peer dep, or
rewrite the middleware (~20 min). Decide when Hono users show up.

---

## ISSUE-013 — Consume `think/framework/` build tooling when a CLI/scaffolding story lands

**Status:** open · **Area:** Integration (audit 28 Tier 2 #7)

Project discovery/config/codegen (~1.7k LOC), zero runtime coupling — operates on
files, not agent instances. Portable as-is (together with `think/server-entry.ts`'s
generated-entry contract) whenever the rebuild grows a `create-think`-style
developer experience. No action until then.
