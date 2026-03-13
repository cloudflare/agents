# @cloudflare/shell

A runtime-agnostic bash interpreter with an in-memory filesystem, 80+ built-in commands, and pluggable backends for SQL, code execution, and HTML-to-Markdown conversion. Runs anywhere: Cloudflare Workers, Node.js, or the browser.

Forked from [just-bash](https://github.com/vercel-labs/just-bash) (Apache-2.0, Vercel Labs).

## Install

```bash
npm install @cloudflare/shell
```

## Quick start

```ts
import { Shell } from "@cloudflare/shell";

const shell = new Shell();

const result = await shell.exec('echo "Hello, world!"');
console.log(result.stdout); // "Hello, world!\n"
console.log(result.exitCode); // 0
```

The shell comes with an in-memory filesystem, environment variables, and all built-in commands ready to go — no configuration required.

## Architecture

```
Input string -> Parser -> AST -> Interpreter -> Output
                                      |
                            +---------+---------+
                            |         |         |
                        In-Memory   Built-in   Pluggable
                        Filesystem  Commands   Interfaces
```

The core (`@cloudflare/shell`) is **runtime-agnostic** — it has no dependencies on Node.js, Workers, or browser APIs. Heavyweight capabilities that require runtime-specific bindings are externalized behind three pluggable interfaces:

> **Workers requirement:** Some built-in commands (`gzip`, `gunzip`, `zcat`, `rg` with compressed files) use `node:zlib`. On Cloudflare Workers, this requires the `nodejs_compat` compatibility flag in your `wrangler.jsonc`. The `denyPrivateRanges` network option uses `node:dns` for DNS resolution, which also requires `nodejs_compat`.

| Interface           | Enables command                        | Workers adapters                 | Node.js adapter         | Embedded adapter   |
| ------------------- | -------------------------------------- | -------------------------------- | ----------------------- | ------------------ |
| `SqlExecutor`       | `sqlite3`                              | `DOSqlExecutor`, `D1SqlExecutor` | `BetterSqlite3Executor` | &mdash;            |
| `CodeExecutor`      | `js-exec`, `node`, `python3`, `python` | `DynamicIsolateExecutor`         | `ChildProcessExecutor`  | `EmbeddedExecutor` |
| `MarkdownConverter` | `html-to-markdown`                     | `WorkersAIMarkdownConverter`     | `TurndownConverter`     | &mdash;            |

## Entry points

| Import                       | Purpose                                   |
| ---------------------------- | ----------------------------------------- |
| `@cloudflare/shell`          | Core shell, filesystem, interfaces, types |
| `@cloudflare/shell/workers`  | Cloudflare Workers adapters               |
| `@cloudflare/shell/node`     | Node.js adapters                          |
| `@cloudflare/shell/embedded` | Embedded WASM adapters (QuickJS, Pyodide) |

## Usage on Cloudflare Workers

```ts
import { Shell } from "@cloudflare/shell";
import {
  DOSqlExecutor,
  DynamicIsolateExecutor,
  WorkersAIMarkdownConverter
} from "@cloudflare/shell/workers";

// Inside a Durable Object or Agent:
const shell = new Shell({
  sql: new DOSqlExecutor(this.ctx.storage.sql),
  executor: new DynamicIsolateExecutor({ loader: env.LOADER }),
  markdown: new WorkersAIMarkdownConverter(env.AI)
});

await shell.exec(
  "sqlite3 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)'"
);
await shell.exec("sqlite3 \"INSERT INTO users (name) VALUES ('Alice')\"");
const result = await shell.exec("sqlite3 -json 'SELECT * FROM users'");
// [{"id":1,"name":"Alice"}]
```

## Usage on Node.js

```ts
import { Shell } from "@cloudflare/shell";
import Database from "better-sqlite3";
import TurndownService from "turndown";
import {
  BetterSqlite3Executor,
  ChildProcessExecutor,
  TurndownConverter
} from "@cloudflare/shell/node";

const shell = new Shell({
  sql: new BetterSqlite3Executor(new Database(":memory:")),
  executor: new ChildProcessExecutor(),
  markdown: new TurndownConverter(() => new TurndownService())
});

await shell.exec('js-exec "console.log(1 + 1)"');
// stdout: "2\n"

await shell.exec('echo "<h1>Hello</h1>" | html-to-markdown');
// stdout: "# Hello\n"
```

## Shell options

```ts
const shell = new Shell({
  // Pre-populate the in-memory filesystem
  files: {
    "/data/config.json": '{"key": "value"}',
    "/scripts/setup.sh": "echo 'running setup'"
  },

  // Set environment variables
  env: { API_KEY: "sk-...", NODE_ENV: "production" },

  // Set the working directory (default: /home/user)
  cwd: "/workspace",

  // Pluggable interfaces (see above)
  sql: mySqlExecutor,
  executor: myCodeExecutor,
  markdown: myMarkdownConverter,

  // Network access for curl (disabled by default)
  network: {
    allowedUrlPrefixes: ["https://api.example.com"],
    allowedMethods: ["GET", "POST"]
  },

  // Execution limits (all optional, shown with defaults)
  executionLimits: {
    maxCallDepth: 100,
    maxCommandCount: 10_000,
    maxLoopIterations: 10_000,
    maxStringLength: 10_485_760, // 10 MB
    maxOutputSize: 10_485_760, // 10 MB
    maxArrayElements: 100_000,
    maxSubstitutionDepth: 50
  },

  // Restrict available commands to a subset
  commands: ["echo", "cat", "ls", "grep", "jq"],

  // Add custom commands
  customCommands: [myCommand],

  // Provide a custom filesystem implementation
  fs: myCustomFs
});
```

## Exec options

```ts
const result = await shell.exec("echo $MY_VAR", {
  // Additional environment variables for this execution
  env: { MY_VAR: "hello" },

  // Replace all env vars instead of merging
  replaceEnv: false,

  // Override the working directory for this execution
  cwd: "/tmp",

  // Provide stdin content
  stdin: "line1\nline2\n",

  // Abort long-running commands
  signal: AbortSignal.timeout(5000),

  // Pass positional arguments ($1, $2, ...)
  args: ["arg1", "arg2"]
});

// result.stdout  - standard output
// result.stderr  - standard error
// result.exitCode - exit code (0 = success)
// result.env     - environment variables after execution
```

## Built-in commands

80+ commands organized by category:

**I/O** &mdash; `echo`, `printf`, `cat`, `tac`, `head`, `tail`, `tee`, `rev`, `nl`, `fold`, `expand`, `unexpand`, `strings`, `column`, `wc`, `od`

**Filesystem** &mdash; `ls`, `mkdir`, `rmdir`, `touch`, `rm`, `cp`, `mv`, `ln`, `chmod`, `pwd`, `readlink`, `stat`, `find`, `tree`, `du`, `basename`, `dirname`, `file`, `split`

**Text processing** &mdash; `grep`, `fgrep`, `egrep`, `rg`, `sed`, `awk`, `sort`, `uniq`, `comm`, `cut`, `paste`, `tr`, `join`, `diff`

**Data** &mdash; `jq`, `base64`, `md5sum`, `sha1sum`, `sha256sum`, `expr`, `seq`

**Archives** &mdash; `tar`, `gzip`, `gunzip`, `zcat`

**Environment** &mdash; `env`, `printenv`, `alias`, `unalias`, `history`, `which`, `whoami`, `hostname`

**Control** &mdash; `bash`, `sh`, `xargs`, `true`, `false`, `sleep`, `timeout`, `time`, `date`, `clear`, `help`

**Network** (requires `network` config) &mdash; `curl`

**Interface-backed** (require pluggable adapters) &mdash; `sqlite3`, `js-exec`, `node`, `python3`, `python`, `html-to-markdown`

### Bash features

The interpreter supports a broad subset of bash:

- **Pipes and redirects** &mdash; `|`, `>`, `>>`, `<`, `2>&1`, `&>`, heredocs (`<<EOF`)
- **Variables** &mdash; `$VAR`, `${VAR}`, `${VAR:-default}`, `${#VAR}`, `${VAR/pattern/replace}`
- **Parameter expansion** &mdash; `${VAR:offset:length}`, `${VAR%%pattern}`, `${VAR##pattern}`, `${VAR^}`, `${VAR,}`
- **Arithmetic** &mdash; `$(( ))`, `let`, `(( ))`, full C-style operators
- **Command substitution** &mdash; `$(command)`, `` `command` ``
- **Process substitution** &mdash; `<(command)`, `>(command)`
- **Control flow** &mdash; `if/elif/else/fi`, `for/while/until/do/done`, `case/esac`, `select`
- **Logic** &mdash; `&&`, `||`, `!`, `[[ ]]`, `[ ]`
- **Functions** &mdash; `function name { }`, `name() { }`, `local`, `return`
- **Arrays** &mdash; indexed (`arr=(a b c)`) and associative (`declare -A`)
- **Globbing** &mdash; `*`, `?`, `[...]`, `**` (with `shopt -s globstar`)
- **Brace expansion** &mdash; `{a,b,c}`, `{1..10}`, `{01..100..5}`
- **Here documents** &mdash; `<<EOF`, `<<-EOF`, `<<<`
- **Signals** &mdash; `trap` (limited to EXIT, ERR, DEBUG)
- **Options** &mdash; `set -euo pipefail`, `shopt -s extglob nullglob`

## Custom commands

Register your own TypeScript functions as shell commands:

```ts
import { Shell, defineCommand } from "@cloudflare/shell";

const greet = defineCommand("greet", async (args, ctx) => {
  const name = args[0] || "world";
  return { stdout: `Hello, ${name}!\n`, stderr: "", exitCode: 0 };
});

const shell = new Shell({ customCommands: [greet] });
await shell.exec("greet Alice"); // "Hello, Alice!\n"
await shell.exec("greet Alice | tr a-z A-Z"); // "HELLO, ALICE!\n"
```

Custom commands receive full access to the `CommandContext`:

```ts
defineCommand("wordcount", async (args, ctx) => {
  // Read from stdin (piped input)
  const input = ctx.stdin || (await ctx.fs.readFile(ctx.cwd + "/" + args[0]));
  const count = input.split(/\s+/).filter(Boolean).length;
  return { stdout: `${count}\n`, stderr: "", exitCode: 0 };
});
```

## In-memory filesystem

The shell includes a full POSIX-like in-memory filesystem:

```ts
const shell = new Shell({
  files: {
    "/data/users.json": '[{"name": "Alice"}]',
    "/config/.env": "API_KEY=secret"
  }
});

// Access the filesystem directly
await shell.fs.writeFile("/tmp/output.txt", "result data");
const content = await shell.fs.readFile("/tmp/output.txt");

// Or through shell commands
await shell.exec("cat /data/users.json | jq '.[0].name'");
```

Features: files, directories, symlinks, permissions (`chmod`), lazy file loading, `/proc` filesystem, `/dev/null`, `/dev/urandom`.

You can also provide your own `IFileSystem` implementation for custom backends.

## Network access

Network access is **disabled by default**. Enable it with an explicit allow-list:

```ts
const shell = new Shell({
  network: {
    allowedUrlPrefixes: ["https://api.example.com/v1/"],
    allowedMethods: ["GET"],
    maxRedirects: 10,
    timeoutMs: 30_000,
    maxResponseSize: 10_485_760,
    denyPrivateRanges: true // SSRF protection
  }
});

await shell.exec("curl https://api.example.com/v1/users");
```

## Execution limits

All limits are enforced to prevent runaway execution. Override any default:

```ts
const shell = new Shell({
  executionLimits: {
    maxCallDepth: 100, // Function recursion depth
    maxCommandCount: 10_000, // Total commands per exec()
    maxLoopIterations: 10_000, // while/for/until iterations
    maxAwkIterations: 10_000, // AWK loop iterations
    maxSedIterations: 10_000, // SED branch loop iterations
    maxJqIterations: 10_000, // jq loop iterations
    maxGlobOperations: 100_000, // Glob filesystem operations
    maxStringLength: 10_485_760, // 10 MB max string
    maxArrayElements: 100_000, // Max array size
    maxHeredocSize: 10_485_760, // 10 MB max heredoc
    maxSubstitutionDepth: 50, // $() nesting depth
    maxBraceExpansionResults: 10_000,
    maxOutputSize: 10_485_760, // 10 MB stdout+stderr
    maxFileDescriptors: 1024,
    maxSourceDepth: 100, // source/. nesting depth
    maxSqliteTimeoutMs: 5_000,
    maxJsTimeoutMs: 10_000,
    maxPythonTimeoutMs: 10_000
  }
});
```

## Workers adapters (`@cloudflare/shell/workers`)

### `DOSqlExecutor`

Wraps a Cloudflare Durable Object's `SqlStorage` to provide the `sqlite3` command:

```ts
import { DOSqlExecutor } from "@cloudflare/shell/workers";

// Inside a Durable Object:
const sql = new DOSqlExecutor(this.ctx.storage.sql);
const shell = new Shell({ sql });
```

### `D1SqlExecutor`

Wraps a Cloudflare D1 database binding to provide the `sqlite3` command. Use this when you want to query a D1 database from your shell:

```ts
import { D1SqlExecutor } from "@cloudflare/shell/workers";

// Inside a Worker with a D1 binding configured in wrangler.jsonc:
const sql = new D1SqlExecutor(env.DB);
const shell = new Shell({ sql });
```

### `DynamicIsolateExecutor`

Runs code in isolated V8 workers using Cloudflare's [Dynamic Worker Loader](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/) API. User code is embedded as module source and loaded into a fresh isolate — no `eval()` or `new Function()` needed. Enables `js-exec`, `node`, `python3`, and `python` commands:

```ts
import { DynamicIsolateExecutor } from "@cloudflare/shell/workers";

// env.LOADER is a worker_loaders binding configured in wrangler.jsonc
const executor = new DynamicIsolateExecutor({ loader: env.LOADER });
const shell = new Shell({ executor });
```

### `WorkersAIMarkdownConverter`

Uses Cloudflare Workers AI to convert documents to Markdown:

```ts
import { WorkersAIMarkdownConverter } from "@cloudflare/shell/workers";

const markdown = new WorkersAIMarkdownConverter(env.AI);
const shell = new Shell({ markdown });
```

## Node.js adapters (`@cloudflare/shell/node`)

### `BetterSqlite3Executor`

Wraps a [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) database. Requires `better-sqlite3` as a peer dependency.

```ts
import Database from "better-sqlite3";
import { BetterSqlite3Executor } from "@cloudflare/shell/node";

const sql = new BetterSqlite3Executor(new Database(":memory:"));
const shell = new Shell({ sql });
```

### `ChildProcessExecutor`

Spawns `node -e` and `python3 -c` subprocesses for code execution:

```ts
import { ChildProcessExecutor } from "@cloudflare/shell/node";

const executor = new ChildProcessExecutor({
  nodeBin: "node", // default
  pythonBin: "python3", // default
  timeout: 30_000 // default: 30s
});
const shell = new Shell({ executor });
```

### `TurndownConverter`

Wraps any [turndown](https://github.com/mixmark-io/turndown)-compatible service. Requires `turndown` as a peer dependency.

```ts
import TurndownService from "turndown";
import { TurndownConverter } from "@cloudflare/shell/node";

const markdown = new TurndownConverter(
  () => new TurndownService({ headingStyle: "atx" })
);
const shell = new Shell({ markdown });
```

## Embedded adapters (`@cloudflare/shell/embedded`)

Self-contained code execution using WASM-based interpreters. Works everywhere — Workers, Node.js, Deno, browsers — with no platform-specific dependencies.

### `EmbeddedExecutor`

Combines [QuickJS](https://github.com/justjake/quickjs-emscripten) (~500KB WASM) for JavaScript and [Pyodide](https://pyodide.org/) (~10MB WASM) for Python. Both engines are optional — provide one or both:

```ts
import { getQuickJS } from "quickjs-emscripten";
import { loadPyodide } from "pyodide";
import { EmbeddedExecutor } from "@cloudflare/shell/embedded";

// JavaScript only (~500KB)
const executor = new EmbeddedExecutor({
  quickjs: await getQuickJS()
});

// Both languages
const executor = new EmbeddedExecutor({
  quickjs: await getQuickJS(),
  pyodide: await loadPyodide(),
  memoryLimitBytes: 256 * 1024 * 1024, // 256MB (default)
  maxExecutionMs: 30_000 // 30s (default)
});

const shell = new Shell({ executor });
await shell.exec('js-exec "console.log(1+1)"');
await shell.exec('python3 -c "print(2+2)"');
```

The executor wraps user code in a sandbox that captures `console.log`/`console.error` output and provides a `process.env` object for JavaScript. Python code gets redirected `sys.stdout`/`sys.stderr`. No global state leaks between executions.

|               | Workers (`DynamicIsolateExecutor`) | Node.js (`ChildProcessExecutor`) | Embedded (`EmbeddedExecutor`) |
| ------------- | ---------------------------------- | -------------------------------- | ----------------------------- |
| JS engine     | V8 isolate                         | Node.js subprocess               | QuickJS (WASM)                |
| Python engine | Worker isolate                     | python3 subprocess               | Pyodide (WASM)                |
| Platform deps | Worker Loader binding              | node, python3 binaries           | None                          |
| Isolation     | Separate isolate                   | Separate process                 | Same process, sandboxed       |
| Cold start    | Fast (pre-warmed)                  | ~50ms per spawn                  | ~100ms (WASM init)            |
| Bundle size   | 0 (platform-provided)              | 0 (system binaries)              | ~500KB JS, ~10MB Python       |

## Implementing custom adapters

Each interface is small and easy to implement for any runtime:

```ts
import type { SqlExecutor, CodeExecutor, MarkdownConverter } from "@cloudflare/shell";

// SQL — two methods
const sql: SqlExecutor = {
  async query(sql) { return { columns: [...], values: [...] }; },
  async run(sql) { return { changes: 0 }; },
};

// Code execution — one method
const executor: CodeExecutor = {
  async execute(code, language, options?) {
    return { stdout: "", stderr: "", exitCode: 0 };
  },
};

// Markdown conversion — one method
const markdown: MarkdownConverter = {
  async convert(input, options?) { return "# Converted"; },
};
```

## Security

The shell is designed for sandboxed execution:

- **No real filesystem access** &mdash; uses an in-memory filesystem by default
- **No network by default** &mdash; network must be explicitly enabled with an allow-list
- **Execution limits** &mdash; all loops, recursion, string sizes, and output are bounded
- **No prototype pollution** &mdash; environment variables use `Map`, not plain objects
- **SSRF protection** &mdash; optional `denyPrivateRanges` blocks private/loopback IPs
- **Virtual process info** &mdash; `/proc` exposes virtual PIDs, never real host info

## Differences from just-bash

`@cloudflare/shell` is a structural fork, not a patch release. The interpreter and parser heritage is shared, but the packaging, runtime model, and capability surface are substantially different.

### Pluggable interface architecture

just-bash bundles its SQL (sql.js), code execution (QuickJS WASM, CPython WASM), and markdown conversion implementations directly. This gives you a batteries-included experience but couples the core to those specific implementations and their WASM dependencies.

`@cloudflare/shell` extracts these into three small interfaces (`SqlExecutor`, `CodeExecutor`, `MarkdownConverter`) and ships zero implementations in the core. Adapters live in separate entry points:

- `@cloudflare/shell/workers` — wraps Durable Object SqlStorage, Dynamic Worker Loaders, and Workers AI
- `@cloudflare/shell/node` — wraps better-sqlite3, child_process, and turndown
- `@cloudflare/shell/embedded` — wraps QuickJS and Pyodide (similar to just-bash's bundled approach)

This means the core has no WASM or native dependencies and runs anywhere — Workers, Node.js, Deno, the browser — without conditional imports or polyfills. You only pay for the adapters you use.

### Regex engine

just-bash uses native JavaScript `RegExp` for `grep`, `sed`, and `awk`. `@cloudflare/shell` uses [re2js](https://github.com/le0pard/re2js) — a pure-JS port of RE2 — to avoid ReDoS attacks from user-supplied patterns. This is critical when running untrusted shell scripts.

### Execution limits

just-bash has 5 configurable execution limits (`maxCallDepth`, `maxCommandCount`, `maxLoopIterations`, `maxAwkIterations`, `maxSedIterations`). `@cloudflare/shell` adds 13 additional limits covering string length, array size, output size, heredoc size, brace expansion, glob operations, file descriptors, command substitution depth, source file nesting, and per-language execution timeouts. All are designed to prevent resource exhaustion in multi-tenant environments.

### Network security

Both just-bash and `@cloudflare/shell` disable network access by default and support URL prefix allow-lists. `@cloudflare/shell` additionally supports response size limits and optional DNS-level private IP blocking (`denyPrivateRanges`) to prevent SSRF via DNS rebinding.

### Commands not ported from just-bash

just-bash includes `xan` (CSV processing) and `yq` (YAML/XML/TOML/CSV querying). These are not included in `@cloudflare/shell` — `xan` adds significant bundle size for a niche use case, and `yq` overlaps with `jq` for most agent workflows. If you need these, implement them as custom commands.

### What stayed the same

The core bash interpreter, AST parser, expansion engine, command set, in-memory filesystem, `defineCommand()` API, and lazy command loading are derived from just-bash's implementation. The bash compatibility surface (variables, arithmetic, control flow, arrays, globbing, parameter expansion) is largely the same, with incremental fixes.

## License

Apache-2.0
