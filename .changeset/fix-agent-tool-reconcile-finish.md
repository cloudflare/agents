---
"agents": patch
---

Ensure recovered agent-tool runs go through the same terminal lifecycle path as live runs. Parent recovery reconciliation now replays stored child chunks, broadcasts terminal agent-tool events, and invokes `onAgentToolFinish` after updating the parent run registry.
