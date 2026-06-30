---
"agents": patch
---

fix: `addMcpServer` now warns when it falls back to the default OAuth callback URL because no `callbackPath` was provided. The default path embeds the agent instance name and only works when the Worker routes the agents prefix through `routeAgentRequest`; previously the fallback was silent whenever `sendIdentityOnConnect` was `true`, letting OAuth flows hang in `AUTHENTICATING` with no signal.
