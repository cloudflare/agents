---
"@cloudflare/ai-chat": patch
"agents": patch
---

Fix four chat turn races found by model-checking two tabs on one chat:

- Clearing the chat while a reply is pending or streaming no longer lets that reply stream into, or be saved to, the cleared chat.
- Regenerating a reply while another tab's turn is still streaming now replaces that reply, instead of leaving two replies to one message.
- A chat request whose `onChatMessage` throws before streaming now gets an error frame, instead of no response at all.
- A tool result that changes nothing (a second tab answering the same tool call, or a call that no longer exists) no longer starts another auto-continuation.

`TurnQueue` gains `activeGeneration`, the generation the running turn was admitted under.
