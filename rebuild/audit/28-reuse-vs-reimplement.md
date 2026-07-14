# 28 — Integrate vs re-implement: the non-core packages and modules

Assessment of everything outside the two god classes: which of it can be
integrated into the rebuild directly, and on what seam. Based on a coupling
survey of the original monorepo (2026-07-14). The clean-room rule existed to
force architectural independence of the CORE; the core is done, so
integration adapters may now read and depend on the original packages —
what stays forbidden is porting god-class structure back in.

The headline: **almost everything outside `Agent`/`Think` is a leaf the god
class calls into**, often fronted by a purpose-built narrow interface. Only
three things genuinely `extends Agent` (ai-chat's `AIChatAgent`, mcp's
`McpAgent` server class, chat-sdk's `ChatSdkStateAgent`) — those are
re-implement territory; the rest is reusable on evidence.

## Tier 1 — consume as external packages (no lift, no fork)

| Package | Coupling to Agent/Think | Seam in the rebuild |
|---|---|---|
| `@cloudflare/codemode` | **None** (grep-clean; own DO; optional AI-SDK entrypoints) | Needs only a `DurableObjectState`. Natural fit: a `Sandbox` port adapter (`ports/sandbox.ts` is the reserved seam) and/or a codemode tool provider. Its tool shape (raw-JSON-schema `ConnectorTool`) matches ours. |
| `@cloudflare/shell` | **None** (only its tests import `agents`) | Rides codemode; needs a `StateBackend` + DO state. Overlaps our `domain/workspace` VFS — see "overlap policy" below. |
| `hono-agents` | 2 symbols: `routeAgentRequest` + `AgentOptions` type | Our `routeAgentRequest` already matches the shape (Response with `webSocket`). Reusable with a type shim; a rewrite is ~86 lines anyway. |
| `@cloudflare/voice` | Mixin over `Pick<Agent, "sql" \| "getConnections" \| "keepAlive">`, wraps `onConnect`/`onMessage`; own `voice_*` WS protocol (not `cf_agent_*`) | Voice is transport-adjacent, so in the rebuild it belongs at the **shell**, not on the agent. Route: a shell-level compatibility facade exposing `sql` (real DOs have `ctx.storage.sql`), `getConnections` (durable registry), `keepAlive` (Agent's protected service), and connect/message override points. Moderate glue, architecturally consistent. |
| `@cloudflare/ai-chat` | Maximal: extends Agent, private `agentContext` ALS, ~60 `agents/chat` internals, AI-SDK `UIMessage` model | **Not reusable — it IS the thing the rebuild replaces.** Quarry for behaviors only. |

## Tier 2 — lift-in modules (leaf code behind narrow interfaces)

Ranked by value to the rebuild:

1. **`agents/src/mcp/` client stack (~6.9k LOC)** — the whole MCP client
   (transports, OAuth provider, x402, connection lifecycle) imports nothing
   from Agent; its only internal dep is the standalone `core/events` util.
   The rebuild's `ExternalToolSource` port ("MCP and friends") is exactly the
   seam, and we have no MCP implementation yet. **Highest-value lift**: bring
   the client + `core/events`, write a thin `ExternalToolSource` adapter.
   (The `McpAgent` *server* class extends Agent — re-implement that half on
   the shell if/when needed.)
2. **`think/src/extensions/` (~1.2k LOC)** — the designed plugin seam, and
   it's genuinely clean: `ExtensionManager` takes a pure options object
   (`WorkerLoader`, storage, `createHostBinding`), extensions are sandboxed
   Workers with a manifest/permissions contract, and the host implements a
   fixed 9-method `_host*` bridge (read/write/delete/list files, get/set
   context, get messages, send message, session info). Lift the manager +
   bridge, implement the 9 methods over our workspace/session/Think surface,
   wire `WorkerLoader` in the Cloudflare shell. New capability, not overlap.
3. **`agents/src/client.ts` + `react.tsx` (~61 KB)** — type-only coupling to
   the core; they depend on the `cf_agent_*` protocol vocabulary
   (`MessageType` enum), which we deliberately preserved. Reusable **as-is**
   against the rebuild's WS adapter — this is the payoff of the wire-compat
   decision. Action: the deferred client-compat smoke test, driving the real
   `agents/react` client at our shell, becomes the proof.
4. **`agents/src/browser/` (~3.1k LOC)** — CDP browser automation; exactly
   one coupling line (an optional `agentContext` ALS fallback to reach
   `agent.ctx`, bypassed by passing `ctx` in options). Near-verbatim lift
   when browser tools are wanted; expose through our tool shape (we now have
   `ai` v6 in adapters, so its AI-entry tools convert cheaply).
5. **`agents/src/observability/` (~0.7k LOC)** — pure `emit(event)` interface
   + `node:diagnostics_channel` fan-out; zero coupling. Cheap adapter over
   our kernel `EventBus` whenever standardized observability is wanted.
6. **`think/src/messengers/` + `channels/` (~2k LOC)** — decoupled behind a
   self-defined `MessengerThinkHost` interface (fibers + sub-agents +
   `StreamCallback`), all of which the rebuild has. Plausible lift with an
   adapter implementing that interface over rebuilt Think; do it when a
   real messenger surface (Telegram etc.) is needed.
7. **`think/src/framework/` (~1.7k LOC)** — build-time project
   discovery/config/codegen; zero runtime coupling. Portable whenever the
   rebuild grows a CLI/scaffolding story. No action now.

## Overlap policy — where the rebuild already has a clean-room equivalent

Three originals overlap modules we already built and tested:

- **Session** (`agents/experimental/memory/session`, ~5k LOC): already
  hexagonal — `Session(storage: SessionProvider)` where the DO provider
  touches only `agent.sql`. It is richer than our `domain/session`
  (tree-branching messages, FTS5 search, byte-budgeted hydration, Postgres
  providers). Honest note: had this been surveyed before wave 3, session
  might have been a lift, not a rewrite. Now our session is woven into turn
  assembly and recovery, so: **keep ours; treat the original as a feature
  quarry** (branching + search first), with a later swap behind a
  `SessionProvider`-shaped port as a live option — its message type is
  AI-SDK `UIMessage`-shaped, which is the main translation cost.
- **Skills** (`agents/src/skills/`, R2-backed + codemode execution): ours is
  a clean-room registry. The original becomes attractive as an **additional
  `SkillSource`/runner adapter** once codemode is integrated.
- **Workspace/fetch/execute tool factories** (`think/src/tools/`): built on
  shell's `Workspace`/codemode with richer capability (bash, grep, git).
  Keep our `domain/workspace` + fetch tool as the port; when shell/codemode
  land (Tier 1), add a shell-backed adapter implementing our workspace port
  rather than swapping tool layers wholesale.

## Suggested sequence (each its own wave, adapters only, core frozen)

1. MCP client lift behind `ExternalToolSource` (fills a real gap).
2. codemode (+shell) integration behind the `Sandbox` port / tool provider.
3. Client-compat smoke test with the real `agents/react` package (validates
   Tier-2 #3 and the wire-compat guarantee).
4. Extensions plugin seam (manager lift + 9-method host bridge).
5. Browser tools; observability adapter; messengers — on demand.

Vendoring mechanics: standalone packages (`codemode`, `shell`) are npm
dependencies; in-package modules (mcp client, extensions, browser,
observability) get vendored into the rebuild tree (or a future extracted
package) since `agents` itself is the package being replaced and can't stay
a dependency long-term.
