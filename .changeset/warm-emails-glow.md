---
"agents": patch
---

Fix email routing to handle lowercased agent names from email infrastructure

Email servers normalize addresses to lowercase, so `SomeAgent+id@domain.com` arrives as `someagent+id@domain.com`. The router now registers a lowercase key in addition to the original binding name and kebab-case version, so all three forms resolve correctly.
