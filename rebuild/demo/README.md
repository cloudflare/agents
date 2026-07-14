# Interactive demo — the rebuilt Think, touchable

A terminal chat REPL running the full rebuilt system on real (non-test)
adapters:

| Port | Adapter |
| ---- | ------- |
| KeyValueStore (DO storage) | `src/adapters/node/file-store.ts` — one JSON file, so state survives restarts |
| AlarmTimer (DO alarm slot) | `src/adapters/node/real-time.ts` — wall-clock setTimeout |
| ModelClient (the LLM)      | `src/adapters/anthropic/model.ts` — streaming Messages API via the official SDK; or an offline scripted model |
| Transport                  | the CLI itself — stdin lines become method calls, the conversation event log renders to stdout |

Nothing in `src/domain` or `src/app` knows the difference between this and the
in-memory test harness — that's the ports-and-adapters payoff.

## Run

```sh
npm install
npm run demo               # real model if ANTHROPIC_API_KEY (or an `ant auth login`
                           # profile) is available; offline scripted model otherwise
npm run demo -- --offline  # force the offline model
npm run demo -- --fresh    # wipe persisted state first
DEMO_MODEL=claude-opus-4-8 npm run demo   # pick the model
```

## Things to try

- **Streaming** — any message streams token by token (chunk events from the
  durable log, rendered live).
- **Workspace tools** — `write a note about ducks`, then `/ws` to peek at the
  virtual filesystem.
- **Human-in-the-loop** — `email bob about the launch` triggers the
  approval-gated `send_demo_email` action: the turn suspends, you get a
  `[y/N]` prompt, and approval runs the action and auto-continues the turn.
  The action is idempotent (keyed on recipient+subject) — approve the same
  email twice and the second run replays the ledger instead of re-sending.
- **Durability (the flagship)** — hit **Ctrl+C while an answer is streaming**,
  then `npm run demo` again. The restart finds the interrupted turn's fiber
  row in the state file, commits the streamed partial to history, and runs a
  continuation turn. This is the same recovery path a Durable Object eviction
  would take in production.
- `/history`, `/clear`, `/quit`.

State lives in `demo/.demo-state.json` — delete it (or `--fresh`) to start over.
