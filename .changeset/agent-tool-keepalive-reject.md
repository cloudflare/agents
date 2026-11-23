---
"agents": patch
---

An agent-tool run whose child cannot hold its isolate (for example a sub-agent past the platform's subrequest depth) now ends `error` with the cause, instead of staying `running` and leaving the parent waiting.
