---
"agents-sdk": patch
---

clear initial message cache on unmount, add getInitialMessages

This clears the initial messages cache whenever useAgentChat is unmounted. Additionally, it adds a getInitialMessages option to pass your own custom method for setting initial messages. Setting getInitialMessages:null disables any fetch for initial messages, so that the user can populate initialMessages by themselves if they'd like.

I also added a chat example to the playground.
