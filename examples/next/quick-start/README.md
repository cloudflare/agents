# Next: quick start

The agent from the quick start in the [repository README](../../../README.md): Pi on a plain Durable Object, running a Workers AI model with one tool that reads web pages.

`src/index.ts` is the code the README shows. `pnpm run check:readme` fails if the two differ, so CI typechecks the quick start on every pull request. Edit both together.

## Run

```sh
pnpm install
pnpm run dev
```

Workers AI runs on your Cloudflare account, so `wrangler dev` asks you to log in. Then ask the agent something:

```sh
curl -d "Summarize https://developers.cloudflare.com/agents/" http://localhost:8787
```

The endpoint has no auth. Add some before you deploy it.
