# Channels / Surfaces

The abstract notion of a *surface* a turn arrives on (web, messenger, voice,
custom): its per-surface policy and its out-of-band delivery, independent of any
wire format. The WebSocket wire realization of the web surface lives in the
`src/adapters/websocket-chat/` transport adapter. See the
[context map](../../../CONTEXT-MAP.md).

## Language

**Channel**:
A surface a turn arrives on, carrying per-surface policy and an out-of-band
delivery mechanism.
_Avoid_: surface (informal only — Channel is the canonical term); note the Kernel's
**observability channel** is an unrelated concept.

**ChannelKind**:
A purely descriptive label for the surface: web, messenger, voice, or custom.
Carried into events for observability; behaviour does **not** fork on it. There is
no privileged kind — including `web`, which is now just another channel (no implicit
registration, no special delivery).
_Avoid_: reading it as behaviour — delivery forks on a `deliver` hook, not on kind.

**Default sink (transcript)**:
Where a notice goes when there is no active channel, or the target channel has no
`deliver` hook: appended to the transcript (via the `transcriptNotice` seam Think
wires). The transcript is universal to a chat agent, so it needs no channel — there
is no privileged "web" channel standing in for it.

**Delivering channel**:
A channel that carries a `deliver` hook; its out-of-band messages go through
`deliver.post(...)`. A channel with no hook falls back to the default sink. This
hook-vs-no-hook split — not the kind — is the one delivery distinction the module
makes.

**ChannelContext**:
The in-flight channel identity for the current turn (channel id, kind, optional
thread).
_Avoid_: active channel (used loosely for the same thing)

**ChannelDefinition**:
A channel's configuration: instructions, a tool filter, a turn cap, capabilities,
and a delivery hook.

**Channel policy**:
The overridable defaults a channel applies to a turn — instructions prepended, tool
filter, turn cap — resolved *before* `beforeTurn`, which wins.
_Avoid_: channel config, rules

**Channel stamping**:
Writing the channel id onto the inbound user message so a recovered or continued
turn re-resolves and re-applies the same channel.

**ChannelDelivery**:
The outbound `post(text, { kind, thread? })` hook for a surface, where kind is
final / interim / notice / command.
_Avoid_: transport, sender

**Notice**:
An out-of-band message delivered without running a model turn; when it lands on the
transcript, an assistant transcript message flagged as a notice.
_Avoid_: system message, toast

**Tool filter**:
A function that may only *narrow* a tool set for a channel, never add — adding an
absent tool is an error.
_Avoid_: tool policy
