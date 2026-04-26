---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Fix Think persisting a duplicate orphan assistant row when a user submits during a streaming tool turn ([#1381](https://github.com/cloudflare/agents/issues/1381)).

When `useAgentChat` posts an in-flight assistant snapshot it minted optimistically (client-generated ID, `state: "input-available"`), Session's INSERT-OR-IGNORE-by-ID would store it as a separate row alongside the eventual server-owned assistant for the same `toolCallId`. The next turn's `convertToModelMessages` then produced a malformed Anthropic prompt and the provider rejected it.

`reconcileMessages` and `resolveToolMergeId` now live in `agents/chat` and Think runs them in `_handleChatRequest` before persistence. Stale `input-available` snapshots pick up the server's tool output via `mergeServerToolOutputs`, and any incoming assistant whose `toolCallId` already exists on a server row adopts the server's ID so persistence updates the existing row instead of inserting an orphan.

`@cloudflare/ai-chat` keeps its existing reconciler behavior; the only change is that it now imports `reconcileMessages` / `resolveToolMergeId` from `agents/chat` instead of a local file.
