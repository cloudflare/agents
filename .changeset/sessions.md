---
"agents": minor
---

Sessions: compaction and search.

- Sessions resolves what the model sees from the newest message back: compaction overlays apply at any length, reads cost what they return, and deleting messages keeps overlays applying (#2871). Behaviour changes: `addCompaction()` throws on anchors that can never apply, overlapping hand-written overlays resolve to the one ending later, and reads that start at the root throw past 200,000 visible messages. Existing overlays are carried forward on start. See [Sessions](https://developers.cloudflare.com/agents/api-reference/sessions/#compaction).
- Long compacted chats no longer send raw history to the model (#3056).
- A long session compacts in rounds instead of failing to load.
- The next request no longer fails with "web_search_call was provided without its required reasoning item" (#3090).
- Sessions takes an optional `name` (experimental): a second Sessions in the same Durable Object keeps its own transcripts, compactions, search and attachments.
- Search no longer fails on a message larger than one row or overflows the stack on a long text (#3075, #3124, #3084).
