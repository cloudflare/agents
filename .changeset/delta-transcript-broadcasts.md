---
"agents": minor
"@cloudflare/think": minor
---

Broadcast transcript deltas at turn boundaries.

`agents` gains two protocol frames: `cf_agent_chat_messages_delta`
(server → client, carrying only the messages a turn boundary persisted plus
the `epoch` of the snapshot they apply to) and
`cf_agent_chat_client_capabilities` (client → server, declaring which optional
frames the client applies). `cf_agent_chat_messages` now carries an optional
`epoch`. `useAgentChat` declares `transcriptDeltas` on every socket open and
applies deltas by id, falling back to nothing when the epoch does not match
the snapshot it holds.

`@cloudflare/think` sends a delta instead of a full snapshot at a turn
boundary when every connection is aligned to the current transcript epoch and
has declared delta support. Connect/resume, branch and regeneration,
compaction, clear, transcript repair, and a discarded overflow-retry partial
still send the full snapshot. A client that has not declared delta support —
including any client on an older `agents` release — keeps receiving snapshots.
