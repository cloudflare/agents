---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Allow interfaces with named fields to be used as startup props. `Agent`, `AIChatAgent`, `Think`, `Lifecycle`, `getAgentByName`, `routeAgentRequest`, and the routing option types now constrain and default `Props` to `object` instead of `Record<string, unknown>`. Because the default changed, every API bounded by bare `Agent` (`AgentNamespace`, `subAgent`, `parentAgent`, `RoutedAgents`, `AgentWorkflow`, dynamic agents) accepts an Agent with interface-typed props, and explicit type arguments such as `getAgentByName<Env, MyAgent>(...)` no longer fall back to the index-signature requirement. Untyped `onStart(props)` overrides keep working; annotate the parameter as `Record<string, unknown>` if you read arbitrary keys from it.
