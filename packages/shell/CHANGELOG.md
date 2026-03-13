# @cloudflare/shell

## 0.0.1

### Patch Changes

- [#1103](https://github.com/cloudflare/agents/pull/1103) [`fd1f435`](https://github.com/cloudflare/agents/commit/fd1f4352aca9c62f4ab6b16fb9ab940e89dd8c6f) Thanks [@threepointone](https://github.com/threepointone)! - Initial release of `@cloudflare/shell` — a runtime-agnostic bash interpreter forked from [just-bash](https://github.com/vercel-labs/just-bash) (Apache-2.0, Vercel Labs).
  - 80+ built-in commands: I/O, filesystem, text processing, data, archives, network (`curl`), and control flow
  - In-memory POSIX-like filesystem with symlinks, permissions, `/proc`, `/dev/null`, `/dev/urandom`
  - Full bash subset: pipes, redirects, variables, arithmetic, arrays, globbing, brace expansion, functions, heredocs, `set -euo pipefail`
  - Pluggable interfaces for SQL (`SqlExecutor`), code execution (`CodeExecutor`), and HTML-to-Markdown conversion (`MarkdownConverter`)
  - Configurable execution limits to prevent resource exhaustion in multi-tenant environments
  - RE2-based regex engine via [re2js](https://github.com/le0pard/re2js) for ReDoS-safe `grep`, `sed`, and `awk`
  - Network access disabled by default with URL allow-list and optional SSRF protection (`denyPrivateRanges`)
  - Workers adapters (`@cloudflare/shell/workers`): `DOSqlExecutor` (Durable Object SqlStorage), `D1SqlExecutor` (Cloudflare D1), `DynamicIsolateExecutor` (Worker Loader), `WorkersAIMarkdownConverter`
  - Node.js adapters (`@cloudflare/shell/node`): `BetterSqlite3Executor`, `ChildProcessExecutor`, `TurndownConverter`
  - Embedded adapters (`@cloudflare/shell/embedded`): `EmbeddedExecutor` with QuickJS and Pyodide WASM
