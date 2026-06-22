---
"agents": patch
"@cloudflare/think": patch
---

Extract transcript repair into a shared `agents/chat` primitive.

`@cloudflare/think`'s `_repairToolTranscriptParts` — which flips an interrupted
tool call (a `tool-*` / `dynamic-tool` part with no settled result, left behind
when a stream was cut off mid-flight) into an errored tool-result so the next
provider call doesn't 400 with `AI_MissingToolResultsError`, and normalizes
malformed tool `input` — now lives once as the shared, `@internal`
`repairInterruptedToolParts` primitive (plus the `toolPartHasSettledResult`
terminal-state check) in `agents/chat`.

The primitive is pure (returns a new messages array plus repair stats; never
touches storage, broadcast, or events) and is parameterized by an overridable
`repairPart` hook, so both AI-SDK chat hosts can run identical repair logic
before re-entering inference on a recovered turn. `@cloudflare/think` delegates
to it through its existing `repairInterruptedToolPart` hook — a pure internal
refactor with no observable behavior or API change; its suites pass unchanged.
