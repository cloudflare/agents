---
"@cloudflare/think": patch
"agents": patch
---

Fix Think auto-continuation stream resumes so immediate client-tool resume requests attach to the pending continuation instead of receiving `cf_agent_stream_resume_none`.
