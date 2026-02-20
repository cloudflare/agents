# Python Agent Example

Experimental Python Agent using Cloudflare Durable Objects. Demonstrates that Python DOs can implement the same wire protocol as the TypeScript Agents SDK, enabling compatibility with the existing `AgentClient` and `useAgent` React hook.

## What this proves

- Python Durable Objects support WebSocket Hibernation, SQLite storage, and alarms
- A Python `Agent` base class can implement the agent wire protocol (`cf_agent_state`, `cf_agent_identity`, `rpc` message types)
- State management (get/set, persistence, client sync) works identically to the TS SDK
- RPC via `@callable` decorator works for method dispatch
- The existing JS/React clients can connect to a Python agent unchanged

## Setup

Requires [uv](https://docs.astral.sh/uv/) and Node.js.

```bash
uv sync
uv run pywrangler dev
```

Then open http://localhost:8787 for the counter demo UI, or connect via WebSocket:

```bash
websocat ws://localhost:8787/agent/default
```

## Project structure

```
src/
  agent.py    # Python Agent base class (wire protocol implementation)
  entry.py    # CounterAgent example + Worker entrypoint
```

## Wire protocol compatibility

The Python Agent speaks the same WebSocket JSON protocol as `packages/agents`:

| Message type | Direction | Purpose |
|---|---|---|
| `cf_agent_identity` | server → client | Sent on connect with agent name + instance ID |
| `cf_agent_state` | bidirectional | State sync — server broadcasts, client can set |
| `cf_agent_state_error` | server → client | Rejected state update (e.g., readonly) |
| `rpc` | bidirectional | Request/response RPC calls |
