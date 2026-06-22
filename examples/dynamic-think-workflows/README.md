# Dynamic Think Workflows

Run generated `ThinkWorkflow` code at runtime as Dynamic Workers with full durable execution (`step.prompt()`, `step.do()`, `step.sleep()`, `step.waitForEvent()`).

## How it works

1. `MyAgent.runDynamicWorkflow()` stores generated TypeScript source in SQLite and starts a Workflow instance
2. The `DynamicThinkWorkflow` entrypoint (registered in `wrangler.jsonc`) loads the code from the agent, bundles it with its npm dependencies via `@cloudflare/worker-bundler`, and loads it as a Dynamic Worker
3. The Workflows engine dispatches `run(event, step)` to the Dynamic Worker — `step.prompt()` works natively

## Run it

```bash
pnpm install
pnpm run dev
```

Then start a dynamic workflow:

```bash
curl -X POST http://localhost:8787/run \
  -H "Content-Type: application/json" \
  -d '{"topic": "The future of serverless computing"}'
```

## Key concepts

- **Generated code** is plain TypeScript extending `ThinkWorkflow` — not a DSL or interpreter
- **`@cloudflare/dynamic-workflows`** handles routing between the Worker Loader and the Workflows engine
- **`@cloudflare/worker-bundler`** resolves npm dependencies (`@cloudflare/think`, `zod`) at runtime
- The generated workflow has full access to `step.prompt()`, `this.agent`, and all ThinkWorkflow features
