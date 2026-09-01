# Next: dynamic agents

What facets are **for**: running dynamically-supplied code under a
supervisor, with durable storage the supervisor controls.

A `Supervisor` agent stores user-submitted JavaScript defining a
Durable Object class (`Sandbox`). Each "gadget" runs as a **facet** of
the supervisor: its own isolate, its own SQLite database, no wrangler
binding anywhere — the class comes from Worker Loader at runtime.

```
Supervisor (Agent, one DO)
├─ gadgets table: name → source code, version
├─ facet "gadget:counter"   ← Sandbox class from user code v3
│    own SQLite (hits table) — invisible to the supervisor
└─ facet "gadget:notes"     ← Sandbox class from user code v1
     own SQLite
```

Three things only facets can do here:

1. **Durable storage for unbound code.** You cannot give AI-generated
   or user-submitted code a Durable Object namespace binding. A facet
   is the only way it gets persistent, isolated storage — under
   supervision.
2. **Code upgrades over stable state.** `updateGadgetCode` stores new
   source and aborts the facet; the next invocation loads the new
   class **over the same storage** (`invokeGadget` returns the same
   hit counts, served by new code).
3. **Supervised lifecycle.** `abortGadget` stops a misbehaving gadget
   immediately (storage survives); `deleteGadget` wipes it; the
   supervisor decides what capabilities the code holds
   (`globalOutbound: null` — no network).

For statically-known Agent child classes, the same supervision is
available through `this.dynamicAgents` — see `examples/agents-as-tools`.
For many independent peers (chats, sessions), do **not** use facets —
see `examples/next/chats` and the decision rule in
`docs/agents/sub-agents.md`.

## Run

```sh
pnpm install
pnpm run dev
```

## Test

```sh
pnpm run test
```
