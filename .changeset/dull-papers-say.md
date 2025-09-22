---
"agents": minor
---

Fix OAuth callback handling and add HOST auto-detection

- Fix OAuth callback "Not found" errors by removing MCPClientManager
  override
- Add OAuth callback URL persistence across Durable Object hibernation
- Fix OAuth connection reuse during reconnect to prevent state loss
- Add OAuth transport tracking to prevent authorization code consumption
  during auto-fallback
- Preserve PKCE verifier across transport attempts
- Make callbackHost parameter optional with automatic request-based
  detection
- Add URL normalization for consistent transport endpoint handling
