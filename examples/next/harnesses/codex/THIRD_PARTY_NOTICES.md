# Third-party notices

## OpenAI Codex

This example adapts protocol types and turn-processing behavior from
[openai/codex](https://github.com/openai/codex), pinned for research at commit
`5e26f7621c1c470fe62350d61c9eb4d6c772a0da`.

Copyright OpenAI.

Licensed under the Apache License, Version 2.0. The pinned upstream license text
is included in [`LICENSE-CODEX-APACHE-2.0`](./LICENSE-CODEX-APACHE-2.0).

The extracted implementation is substantially changed to remove native
network, filesystem, process, Tokio, and SQLite dependencies and expose a pure
serialized transition ABI suitable for Cloudflare Workers Wasm.
