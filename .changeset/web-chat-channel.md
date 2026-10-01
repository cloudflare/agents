---
"agents": minor
---

Add `agents/channels/web` for live browser chat on arbitrary Durable Objects. The Web Channel uses a separately installed WebSockets capability, routes incoming messages through `ChannelHost`, and encodes the shared rich `ChannelChunk` stream into the existing chat wire protocol.

Add push-based Host ingress and abortable chunk consumption. Include a Web binding in the shared live delivery suite with a bare Durable Object fixture and the existing `WebSocketChatTransport` reader.

This first slice supports live delivery, streaming, and client-tool result continuation through the existing resume offer/ack handshake. Browser cancellation now stops matching delivery and dispatches the same opaque operation identity through `ChannelHost.onCancel`, while conversation reset dispatches through `onConversationReset` and acknowledges the client only after application policy succeeds. Web approvals use the shared `requestApproval`/`onApprovalResponse` interface, leaving continuation policy with the application.

Stable conversation and participant resolution lets multiple live connections share full canonical conversation snapshots, admitted user messages, and ordinary assistant output. Applications resolve transport-neutral conversation history, while the Web Channel projects its rich chunks into browser messages and filters participant-scoped content. The Host serves the default `useAgentChat` `/get-messages` request from that resolver, and sockets retain snapshot hydration for reconnects and peers. Client transcript replacement remains ignored because it is a lossy projection rather than canonical application state. Completed streams reconcile only after the canonical assistant message is available. When the Host has Streams configured, reconnecting clients replay a response's durable neutral chunks through the existing resume handshake and then follow its live tail without duplicates.
