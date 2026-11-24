---
"agents": patch
---

Sessions search no longer overflows the stack when it indexes a long message text: it finds the last word boundary in the indexed slice with a scan instead of a regex.
