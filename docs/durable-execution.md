# Durable Execution

Run work that survives Durable Object eviction. `runFiber()` registers a task in SQLite, keeps the agent alive during execution, lets you checkpoint intermediate state with `stash()`, and calls `onFiberRecovered()` on the next activation if the agent was evicted mid-task.

> This page covers the full API. For how fibers fit into the bigger picture, see [Long-Running Agents](./long-running-agents.md).

## Why fibers exist

Durable Objects get evicted for three reasons:

1. **Inactivity timeout** — ~70–140 seconds with no incoming requests or open WebSockets
2. **Code updates / runtime restarts** — non-deterministic, 1–2x per day
3. **Alarm handler timeout** — 15 minutes

For AI agents, eviction during active work is catastrophic: the upstream LLM connection is severed permanently, in-memory state is lost, and multi-turn agent loops lose their position entirely.

Fibers solve this with two layers:

| Layer | Primitive | Purpose |
| --- | --- | --- |
| 1 | `keepAlive()` | Prevents idle eviction via alarm heartbeats |
| 2 | `runFiber()` | Durable execution — registered in SQLite, checkpointable, recoverable |

`keepAlive()` prevents eviction. `runFiber()` makes eviction survivable.

## API

TODO: Full API reference for `runFiber`, `stash`, `onFiberRecovered`, `FiberContext`, `FiberRecoveryContext`, `keepAlive`, `keepAliveWhile`. Cover inline vs fire-and-forget patterns, concurrent fibers, checkpoint semantics, and testing recovery locally.

See [`forever.md`](../experimental/forever.md) for the current design doc with full details.
