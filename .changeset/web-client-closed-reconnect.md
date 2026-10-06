---
"agents": patch
---

`WebChannelClient`: `send()` and `listConversations()` now reject once the client is closed instead of waiting forever. `follow()` and `close()` also cancel a reconnect still waiting after a dropped connection, so it no longer opens a second socket that replaces the followed one or reconnects a closed client.
