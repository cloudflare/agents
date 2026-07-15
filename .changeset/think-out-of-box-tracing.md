---
"@cloudflare/think": minor
---

Think agents emit Cloudflare-native traces out of the box with no tracing setup beyond enabling Worker traces. Named lifecycle and storage-phase spans group Durable Object internals around startup, request persistence, turn preparation, inference, result persistence, recovery, alarms, and durable submissions. Every inference call produces an `invoke_agent {agent class}` span with `chat {model}` and `execute_tool {tool}` children. Think supplies durable identity and turn metadata. Payload storage remains off by default; agents can set `storeMessages` for full model messages on `chat` and `storeTools` for tool arguments/results on `execute_tool`. These flags configure the wrapper and are never emitted as metadata or attributes. Model streams are finalized on early exit, and durable submissions run from their awaited alarm invocation so spans do not outlive invocation boundaries.
