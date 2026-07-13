---
"agents": minor
---

Agents now self-initialize on every RPC entry surface

Previously, several native Durable Object RPC entry points depended on the caller resolving the stub through `getAgentByName()`, whose `setName()` round-trip is what ran `onStart()` before the first call. An entry point reached on a stub that skipped that round-trip could run before `onStart()` completed.

Every RPC entry surface now runs `onStart()` before executing: `_onEmail`, the sub-agent bridges (`_cf_invokeSubAgent` / `_cf_invokeSubAgentPath`), the schedule/fiber dispatch callbacks, the WebSocket-forwarding facet handlers, and every root facet RPC method (schedules, keepAlive, facet-run registration, broadcast, and sub-agent connection routing) all guard on initialization the same way the existing `_cf_invokeAgentPath` did. User-defined RPC methods on cold stubs also initialize before running, via a synchronous fast path in the auto-wrapping layer that preserves synchronous return values once warm and never re-enters initialization while `onStart()` is in flight.

Because every reachable surface is now self-sufficient, internal resolution sites that only ever invoke self-initializing methods (`_rootAlarmOwner`, `parentAgent`, `AgentWorkflow`'s agent resolution, and email routing — none of which pass `props`) resolve their stub directly and skip the extra round-trip. The public `getAgentByName` / `getServerByName` behavior is unchanged, and no documented semantics change.
