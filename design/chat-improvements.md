# Chat Layer Improvements: Status

This started as a plan of non-breaking improvements to `@cloudflare/ai-chat` (`AIChatAgent` and `useAgentChat`) and a list of code to extract into `agents/chat` so `AIChatAgent` and `Think` could share it. Most of it has shipped. This page records what landed, what did not, and where each piece lives now. The shared layer itself is described in [chat-shared-layer.md](./chat-shared-layer.md).

Related:

- [chat-api.md](./chat-api.md) — the API analysis that motivated these items
- [chat-shared-layer.md](./chat-shared-layer.md) — the `agents/chat` modules
- [think.md](./think.md) — Think's current design

## Where the client code lives

`useAgentChat` and `WebSocketChatTransport` now live in `agents/chat/react` and `agents/chat/transport`. `@cloudflare/ai-chat/react` re-exports the hook and helpers, and `@cloudflare/think/react` wraps the hook (it omits `syncMessagesToServer`). Any client item below therefore applies to both packages.

## Non-breaking additions

| Item                                                                                                        | Status      | Notes                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `getAgentMessages()`                                                                                        | Shipped     | Exported from `agents/chat/react` and both products' `/react` entry points. `useAgentChat` also accepts `getInitialMessages: null` to skip it |
| Tool part helpers (`getToolPartState`, `getToolCallId`, `getToolInput`, `getToolOutput`, `getToolApproval`) | Shipped     | Same exports as above                                                                                                                         |
| `getHttpUrl()` on `useAgent`                                                                                | Shipped     | Used by `useAgentChat` to build the initial-messages URL                                                                                      |
| `continuation` in `OnChatMessageOptions`                                                                    | Shipped     | `true` for server-driven continuations (auto-continue after tool results, `continueLastTurn`, recovery)                                       |
| `onTurnEnd` on `useAgentChat`                                                                               | Shipped     | Receives a `ChatTurnEndEvent`. Not in the original plan                                                                                       |
| `fallbackMessages` on `useAgentChat`                                                                        | Not shipped |                                                                                                                                               |
| Client `onChatError` on `useAgentChat`                                                                      | Not shipped | Think has a server-side `onChatError` hook; there is no client equivalent                                                                     |
| Server `isStreaming` on `AIChatAgent`                                                                       | Not shipped | The client hook returns `isStreaming`, `isServerStreaming` and `isRecovering`                                                                 |

## Shared code extraction

All of these live in `packages/agents/src/chat/`.

| Item                            | Status                  | Notes                                                                                                                                                                                                                                    |
| ------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol handler wiring         | Shipped, smaller        | `parseProtocolMessage` (`parse-protocol.ts`) classifies incoming frames. The proposed `setupChatProtocol` wiring helper was not built; each host still dispatches the parsed events itself                                               |
| Abort controller registry       | Shipped                 | `AbortRegistry` (`abort-registry.ts`), used by both hosts                                                                                                                                                                                |
| Tool state machine              | Shipped                 | `applyToolUpdate` and the update builders (`tool-state.ts`). Think uses them; `AIChatAgent` keeps its own tool-part update path because of its shared `_streamingMessage` reference (see [chat-shared-layer.md](./chat-shared-layer.md)) |
| Request context persistence     | Not shipped as proposed | No shared `RequestContextStore`. Think keeps `lastClientTools` and `lastBody` in its `think_config` table; `AIChatAgent` uses `cf_ai_chat_request_context`                                                                               |
| Stream resume handshake         | Shipped                 | `ResumeHandshake` (`resume-handshake.ts`), used by both hosts                                                                                                                                                                            |
| Broadcast with resume exclusion | Not extracted           | Each host still excludes connections with a pending resume when it broadcasts (Think does this in `_broadcastChat`)                                                                                                                      |

## Deprecations

| Item                                                                                                                                  | Status               | Notes                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `onFinish` parameter on `onChatMessage`                                                                                               | Not deprecated       | Still part of the `AIChatAgent.onChatMessage(onFinish, options)` signature                                               |
| Tool output naming                                                                                                                    | Resolved differently | The plan proposed renaming away from `addToolOutput`. Instead `addToolResult` is deprecated in favour of `addToolOutput` |
| Legacy client options (`toolsRequiringConfirmation`, `experimental_automaticToolResolution`, `autoSendAfterAllConfirmationsResolved`) | Deprecated           | Each logs a one-time warning pointing at `needsApproval`, `onToolCall` or `sendAutomaticallyWhen`                        |
| `Response` return type of `onChatMessage`                                                                                             | Not marked           | No deprecation signal has been added                                                                                     |

## History

- Written as a four-wave plan: quick wins, client DX, shared extraction, deprecation prep. The extraction wave landed first because Think needed it.
- The React hook and transport later moved from `@cloudflare/ai-chat` into `agents/chat` (#1801), which made the client items shared by both products.
- Rewritten as a status record once most items had shipped. The original per-item proposals are in git history.
