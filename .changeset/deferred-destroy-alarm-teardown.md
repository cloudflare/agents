---
"agents": patch
---

Make agent teardown reliable when the initiating request is already canceled (#1625).

The MCP Streamable-HTTP session-DELETE handler ran `agent.destroy()` via the request's `ctx.waitUntil`. By the time the DELETE lands the client is usually gone, the runtime gives a canceled request's trailing work little to no grace, and the multi-step teardown (drop tables, delete alarm, delete all storage, dispose connections) was routinely cut short — leaving half-deleted session DOs whose tables the constructor silently recreated on the next wake. (The associated `waitUntil() tasks did not complete` log warning itself originates inside workerd's WebSocket handling and is unaffected by this change.)

Teardown is now deferred to the agent's own alarm invocation. The DELETE handler awaits two fast storage writes — a durable "condemned" marker plus an immediate alarm — and responds 204; the alarm then runs the real `destroy()` with a fresh execution budget. The marker is removed by the final `deleteAll()`, so it survives any interruption: `alarm()` checks it before any other work (including `onStart`) and finishes the teardown instead of resuming normal operation on a condemned agent, and `_scheduleNextAlarm()` keeps the destroy alarm armed rather than deleting it as "no work pending". `destroy()` itself now writes the marker first, so a direct destroy that gets interrupted converges the same way.

New internal API: `Agent._cf_scheduleDestroy()` (used by the MCP handler; unlike `destroy()` it does not abort the isolate, so callers don't need to swallow an abort error). No public API or storage-schema changes; the marker is a single internal KV record (`cf_agents_destroy_pending`).
