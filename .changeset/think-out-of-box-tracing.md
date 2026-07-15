---
"@cloudflare/think": minor
---

Think agents emit Cloudflare-native traces out of the box with no tracing setup beyond enabling Worker traces. Every inference call produces an `invoke_agent {agent class}` root span with `chat {model}` and `execute_tool {tool}` children. Think supplies durable identity and turn metadata. Payload storage remains off by default; agents can set `storeMessages` to retain full model messages on `chat` and `storeTools` to retain tool arguments/results on `execute_tool`. These are wrapper settings and are never added to telemetry metadata or spans. Drain loops finalize model streams on early exit, and durable submissions run from their awaited alarm invocation so spans do not outlive invocation boundaries.
