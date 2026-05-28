---
"@cloudflare/think": patch
"@cloudflare/ai-chat": patch
"agents": patch
---

Fix auto-continuation stream resumes so immediate client-tool resume requests attach to the pending continuation instead of receiving `cf_agent_stream_resume_none`.
