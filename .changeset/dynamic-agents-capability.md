---
"agents": patch
---

Extract facet ("sub-agent") machinery into `packages/agents/src/dynamic-agents/`, add the `this.dynamicAgents` capability facade, and reposition facets as an isolation primitive rather than the recommended way to model many chat sessions.

`Agent`'s facet routing, WebSocket forwarding, virtual connections, and registry (~2,400 of `index.ts`'s ~12,150 lines) move into a dedicated module registered as a Lifecycle capability (`capabilityId: "dynamic-agents"`); its hot paths stay composition-root wired since the capability-runner hook contract can't express request-rewrite-and-continue or post-claim WebSocket forwarding. No wire- or storage-visible identifier changes.

The public surface gains exactly one addition: `this.dynamicAgents.{get,abort,delete,has,list}`. `subAgent()` / `abortSubAgent()` / `deleteSubAgent()` / `hasSubAgent()` / `listSubAgents()` are unchanged in behavior and now delegate to the same capability — `@deprecated` in place, not removed. `/sub/` URLs, `useAgent({ sub })`, `parentAgent()`, and `onBeforeSubAgent` are untouched.

`docs/agents/sub-agents.md` is rewritten: verified workerd facet semantics (separate isolate, own SQLite, no independent alarms, bounded nesting depth, machine-pinned tree), a corrected claim about WebSocket frame forwarding (every frame wakes the root parent — it was never true that frames go directly to the child post-upgrade), and an explicit decision rule for facets vs. independent Durable Objects. Two new examples: `examples/next/dynamic-agents` (a supervisor running user-submitted Durable Object code as facets via Worker Loader — what facets are for) and `examples/next/chats` (one top-level DO per chat plus a per-user push-based index — the recommended many-chats pattern), both with a React + Vite UI and workers-pool tests.
