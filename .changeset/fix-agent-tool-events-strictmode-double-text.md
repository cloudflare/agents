---
"agents": patch
---

Fix `useAgentToolEvents` doubling streamed text in React StrictMode / SSR frameworks (#1835).

The agent-tool-event reducer (`applyAgentToolEvent` → `applyToRun`) shallow-copied a run's `parts` array with `[...seeded.parts]` and then handed it to `applyChunkToParts`, which mutates part objects in place (e.g. `lastTextPart.text += delta`). Because the copied array still shared its element references with the previous state, those in-place mutations leaked back into `prev`. React double-invokes `setState` updaters in StrictMode and during dev hydration, so each `text-delta` chunk was applied twice against the same already-mutated `prev`, doubling every word. Affected Next.js, TanStack Start, Remix, and any `<React.StrictMode>` app. The reducer now clones each part before mutating, keeping it pure.
