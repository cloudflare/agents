---
"agents": patch
---

Sessions: in a session past 3,000 messages, finding the newest message after a restart or a delete reads one row instead of scanning the session; smaller sessions are unchanged.
