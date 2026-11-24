---
"@cloudflare/worker-bundler": patch
---

Python packages with native extensions (pyyaml, numpy, pydantic-core and others) now install wheels for Python 3.13 (Pyodide 0.28), the version dynamic Workers run. Before, the bundler fetched Python 3.12 wheels, which failed to import.
