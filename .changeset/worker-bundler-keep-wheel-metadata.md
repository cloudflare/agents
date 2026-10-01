---
"@cloudflare/worker-bundler": patch
---

Keep each Python wheel's `METADATA` file when installing packages, so `importlib.metadata.version()` works and packages such as FastAPI 0.142 that import OpenTelemetry at startup can load.
