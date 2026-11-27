---
"@cloudflare/think": patch
---

Fix `deliverNotice` to a messenger thread failing with `ChatSdkStateAdapter is not connected` on a cold agent: the delivery surface now initializes the Chat SDK instance first.
