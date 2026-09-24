---
"@cloudflare/think": patch
---

Return the parsed structured output on wait-mode `TurnResult.output` when `beforeTurn` supplies a `TurnConfig.output` spec; a structured answer that does not parse now ends the turn with `status: "error"` (#2263). Submission inspections carry `messageId`, the id of the assistant message the submission's turn persisted, stamped in the same transaction as the answer (#2264). Also stops an unparseable structured output from raising an unhandled rejection.
