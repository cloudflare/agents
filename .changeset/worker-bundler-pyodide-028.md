---
"@cloudflare/worker-bundler": patch
---

Python packages with native extensions (pyyaml, numpy, pydantic-core and others) now install wheels for the Python the Worker's compatibility date picks: 3.12 before 2025-09-29, 3.13 until 2026-09-07, 3.14 from 2026-09-08 (or the `python_workers_20250116` / `python_workers_314` flags). Before, the bundler always fetched Python 3.12 wheels, which failed to import on newer dates. A `wrangler.toml` or `wrangler.jsonc` in a Python project is no longer uploaded as a module. Packages installed from PyPI take the newest final release, not a newer pre-release.
