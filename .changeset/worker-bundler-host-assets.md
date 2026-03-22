---
"@cloudflare/worker-bundler": patch
---

Separate assets from isolate: `createApp` now returns assets for host-side serving instead of embedding them in the dynamic isolate. Removes DO wrapper code generation and `durableObject` option — mounting is the caller's concern. Preview proxy replaced with Service Worker-based URL rewriting.
