---
"agents": patch
---

Fix `useAgentChat` reordering a terminal/authoritative `CF_AGENT_CHAT_MESSAGES` snapshot when a protected streaming assistant is followed by a later assistant message (#1778). The protected-tail merge is still applied for stale mid-stream snapshots, but when the incoming snapshot already contains the protected assistant followed by a newer assistant (e.g. a Think HITL denial that persists the denied tool message and then appends a follow-up assistant response), protection is cleared and the snapshot is rendered in its authoritative order instead of moving the protected assistant to the end.
