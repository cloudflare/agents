---
"agents": patch
---

Support starting Agent workflows from sub-agent facets by preserving the originating facet path for callbacks and workflow Agent RPC.

- Route workflow callbacks, `this.agent` RPC, progress/completion/error, durable events, and state updates back to the exact originating facet via path-based dispatch.
- Match real Durable Object stub RPC semantics in path dispatch: reject built-in/prototype and JS-internal method names.
- Validate the workflow origin payload version so a mismatched SDK fails with a clear error instead of misreading the shape.
- Document the callback routing constraints (name-based resolution, sub-agent workflow tracking is facet-local, class names must survive bundling).
