---
"@cloudflare/think": patch
---

Remove `lazyWorkspace`, exported by mistake in 0.21.0; lazy remote Workspaces belong in `@cloudflare/computer`'s `getWorkspace`. See [cloudflare/computer#254](https://github.com/cloudflare/computer/issues/254).
