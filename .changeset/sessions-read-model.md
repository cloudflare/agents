---
"agents": minor
---

Sessions resolves what the model sees from the newest message back: compaction overlays apply at any path length (#2871), reads cost what they return instead of what is stored, and deleting messages keeps overlays applying. Behaviour changes: `addCompaction()` throws on anchors that can never apply, overlapping hand-written overlays resolve to the one ending later, and reads that start at the root throw past 200,000 visible messages. Existing overlays are carried forward on start. See [Sessions](https://developers.cloudflare.com/agents/api-reference/sessions/#compaction).
