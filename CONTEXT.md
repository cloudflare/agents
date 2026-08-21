# Cloudflare Agents SDK

The SDK composes durable, stateful agent features on Cloudflare Workers.

## Language

**Capability**:
A reusable Durable Object feature with a cohesive public API that may
participate in lifecycle phases. The feature and its lifecycle participant are
the same conceptual object.
_Avoid_: Component, plugin, adapter

**Lifecycle**:
The host-owned coordination of startup, requests, alarms, and hibernating
WebSocket events for one Durable Object instance.
_Avoid_: Capability lifecycle, Agent lifecycle

**MCP client**:
A capability that manages outbound relationships with MCP servers for one
Durable Object, including their durable catalog and discovered features.
_Avoid_: MCP component, MCP lifecycle
