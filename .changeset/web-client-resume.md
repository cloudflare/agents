---
"agents": patch
---

Channels Web client: after a reconnect, keep reading a response that is still streaming after its turn settled, and follow a turn that restarted under a new response while offline. The AI SDK transport now finishes a stream whose continuation settled while it was sending tool results. `agents tui` fetches a fresh Cloudflare Access token for each reconnect, so a long-lived session survives the token expiring.
