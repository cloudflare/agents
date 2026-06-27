---
"@cloudflare/think": minor
---

Add an opt-in, read-only HTTP fetch capability for Think agents via the new `@cloudflare/think/tools/fetch` export and a `fetchTools` property on `Think`.

`createFetchTools()` generates a generic, allowlisted `fetch_url` tool plus one `fetch_<name>` tool per named service-binding/`Fetcher` target. It is `GET`-only with Workers-grounded SSRF defenses (private/loopback/link-local/`*.internal` blocking, URL normalization, credential rejection), separate download/model/workspace size limits (`maxBytes`, `maxModelChars`, `response: "workspace"` spill), an allowlist-aware redirect policy with cross-origin header stripping, a model header allowlist, and a `tool:fetch` observability event. Disabled by default.
