---
"agents": patch
---

fix(mcp): block full IPv6 link-local range `fe80::/10` in SSRF check

`isBlockedUrl` in the MCP client claimed to block `fe80::/10` but the
previous `startsWith("fe80")` check only matched the narrower
`fe80::/16`, letting valid link-local addresses in the `fe81::`–`febf::`
range slip through. Replaced with a regex that matches the full /10
(first hextet `fe80` through `febf`), factored the IPv6 private-range
logic into `isPrivateIPv6`, and added regression tests for the
previously-leaking prefixes plus negative cases at the /10 boundary
(`fe7f::`, `fec0::`).

Reported in #1325.
