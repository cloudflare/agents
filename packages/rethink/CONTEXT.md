# rethink

Composition model for building Durable Object agents from narrow primitives
instead of god base classes (`Agent`, `Think`).

## Language

**Primitive**:
A plain `(ctx, deps)` object that may expose optional DO-shaped methods. The unit
of composition on a Durable Object.
_Avoid_: plugin, module, mixin

**PrimitiveHost**:
The thin, dispatch-only DO base class that fans shared entrypoints to the
author's primitives. Carries no domain behavior or state.
_Avoid_: Agent base, Think base, god class

**ChannelIn**:
A role a Primitive may implement: transport ingress. Accepts inbound events,
claims them on shared entrypoints, and fans normalized messages to registered
listeners.
_Avoid_: messenger, ingress adapter (as the type name)

**ChannelOut**:
A role a Primitive may implement: transport egress. Opens a progressive stream
to an explicit delivery target.
_Avoid_: messenger, delivery surface (as the type name)

**Channel**:
Informal name for a Primitive that implements ChannelIn, ChannelOut, or both.
Not a type by itself.
_Avoid_: Channel as a single required dual-direction type

**InboundMessage**:
A generic transport-neutral envelope produced by a ChannelIn for listeners:
identity, body, optional attachments, optional reply handle, and optional typed
raw payload. Transport-specific delivery surface details live in the typed reply
handle or raw payload.
_Avoid_: event, payload (without saying which)

**ChannelOut target**:
A channel-owned, explicit delivery destination for ChannelOut. Often derived
from an inbound reply handle, but never required to come from one.
_Avoid_: central OutTarget union, reply context (implies inbound-only)

**OutStream**:
The handle returned by ChannelOut.openStream: write AI SDK UIMessageChunks,
complete, interrupt, error.
_Avoid_: send (as the primary egress API)
