# Delegation

An agent handing work to other agents: the parent-side registry of colocated child
agents, and agent-tool runs — dispatching a child Think as a tool with durable run
tracking, streamed relay, cancellation, and recovery. See the
[context map](../../../CONTEXT-MAP.md).

## Language

**Sub-agent**:
A colocated child agent instance, created or retrieved lazily via the spawner.
_Avoid_: facet (the original term), worker

**SubAgentRegistry**:
The parent-side record of its sub-agents, keyed by class name + name; getting one
registers it on first use.

**parentPath / selfPath**:
The root-first identity chains of class-name/name pairs. A child receives its
parentPath at spawn; its selfPath is the parentPath plus itself.
_Avoid_: lineage, ancestry

**Agent tool**:
A model tool whose executor dispatches a child agent to do subwork and suspends
until the run reaches a terminal state.
_Avoid_: sub-agent tool, delegate tool

**Agent-tool run**:
The durable record of one child dispatch (run id, agent type, status, summary,
output, error, timestamps). The child's instance name is the run id, retained after
completion for drill-in.
_Avoid_: task, job — and note "run" in Durable Runtime means a *fiber run row*.

**RunStatus**:
The lifecycle of a run: running, completed, error, or aborted.

**Relay**:
The stream bridge that forwards a child's streamed events to the parent (onStart /
onEvent / onDone / onError / onInterrupted). Delegation's `ChildChatRelay` is built
on the shared `relayTurn` primitive (`src/domain/events/relay.ts`, adapted for a
child agent in `src/adapters/relay/child-relay.ts`).
_Avoid_: pipe, proxy; do not conflate with Conversation's general `relayTurn` — this
is the *delegation-specific* child relay.

**Event log**:
The per-run, parent-side append log of a child's relayed events, enabling replay and
"tail" for a late-attaching UI.
_Avoid_: confusing with Conversation's `ConversationEventLog` — that is the
agent-wide outbound event stream; this is one run's slice of relayed child events.

**Drill-in**:
Inspecting the retained child instance of a completed run.

**Recovery reconciliation**:
The startup scan that asks each still-`running` child for its real terminal state
and settles the parent's run rows (unreachable child → lost/error).
_Avoid_: recovery (unqualified) — many contexts have a "recovery".
