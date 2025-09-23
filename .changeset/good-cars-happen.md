---
"agents": patch
---

Fix OAuth with auto-fallback transport discovery

- Defer transport saving until OAuth initiation to prevent wrong transport selection
- Preserve auth URL and PKCE verifier across transport attempts
- Fix 404 errors on OAuth callback when using auto-fallback mode
