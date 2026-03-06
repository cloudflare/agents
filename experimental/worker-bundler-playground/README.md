# Worker Bundler Playground

AI-powered Worker Bundler playground: describe what you want and get a running Worker you can test immediately.

Uses `@cloudflare/worker-bundler` to bundle source files at runtime and the Worker Loader binding to load and execute them.

## How it works

1. You describe a Worker in natural language
2. The AI generates TypeScript source files (and optionally a `package.json` for npm deps)
3. `createWorker()` bundles everything into a Worker module
4. The Worker Loader binding loads it
5. You can test it with HTTP requests right in the UI

## Run

```bash
npm install
npm start
```

## Bindings

- **AI** — Workers AI for code generation
- **LOADER** — Worker Loader for running generated Workers
- **WorkerPlayground** — Durable Object for persistent chat + worker state
