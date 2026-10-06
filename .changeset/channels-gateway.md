---
"agents": minor
---

Add `ChannelGateway` to `agents/experimental/channels`: the Worker entry point that verifies channel webhooks, takes Web Channel upgrades through `web()` from `agents/experimental/channels/web`, routes each to the agent object that holds its conversation, and delivers outbound messages. Every Channel that takes ingress needs a `participant` callback, where the application says who the sender is; Channels never picks an identity. The agent object is the authorization boundary: by default each participant gets one of their own, and a `route` callback can share one between participants or refuse them.
