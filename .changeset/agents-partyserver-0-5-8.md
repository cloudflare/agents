---
"agents": patch
---

Bump the `partyserver` dependency to `^0.5.8`, which base64-encodes the
`x-partykit-props` header so props containing non-ASCII characters (e.g.
accented names) no longer trigger workerd's "header value contains non-ASCII
characters" warning (which throws a `TypeError` in browser fetch
implementations). The header is decoded back to the original Unicode payload on
the server, and raw-JSON values from older callers are still accepted for
backwards compatibility.
