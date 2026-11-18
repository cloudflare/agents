---
"agents": patch
---

Export `normalizeCdpSpec` and `RawCdpProtocol` from `agents/browser`, so a custom `BrowserSource` can build its `spec()` from protocol JSON it already has. See [Lower-level helpers](https://github.com/cloudflare/agents/blob/main/docs/agents/browse-the-web.md#lower-level-helpers).
