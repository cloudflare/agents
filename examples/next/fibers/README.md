# Next: fibers

An early-access, server-only example showing `Fibers` from `agents/fibers`
installed on a plain Cloudflare `DurableObject`. It does not extend `Agent` or
another SDK base class.

```ts
export class ReportObject extends DurableObject<Env> {
  readonly fibers = new Fibers({
    definitions: {
      "publish-report@v1": async (input: ReportInput, step: FiberStep) => {
        const summary = await step.do("draft", () =>
          this.draftSummary(input.topic)
        );
        await step.sleep("editorial-hold", input.holdSeconds * 1000);
        await step.do("publish", () => {
          // Runs on whichever instance the shared alarm wakes; the draft
          // step above replays from the journal instead of executing again.
        });
        return { topic: input.topic, summary };
      }
    }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.fibers);
}
```

The constructor map is the registry, exactly like `Scheduler` callbacks: it
is rebuilt on every wake, so in-flight runs always resolve their persisted
definition names — recovery is correct by construction. Runs start with
`this.fibers.run("publish-report@v1", input, options)`, and
`this.fibers.handle(name)` gives a typed lens scoped to one definition.

The Fibers capability takes no wiring: storage, alarm coordination, the host
invocation boundary, and events all come from the Lifecycle it is installed
on. It owns its own `cf_fiber_runs` and `cf_fiber_steps` tables and
contributes its earliest run deadline to Lifecycle's shared physical alarm,
so it composes with the Scheduler and other capabilities that also need
wake-ups.

## Run

```sh
pnpm install
pnpm run dev
```

Exercise the named object `demo`:

```sh
# Start a durable report run with a 10 second editorial hold.
curl -X POST http://localhost:8787/agents/report-object/demo/reports \
  -H "content-type: application/json" \
  -d '{"topic": "durable execution", "holdSeconds": 10}'

# The run parks on the sleep: state "waiting", reason "sleep", and the last
# step.status() message. Published reports appear once the hold passes.
curl http://localhost:8787/agents/report-object/demo

# Repeating the same topic joins the existing run instead of starting a
# second one ("accepted": false, same runId).
curl -X POST http://localhost:8787/agents/report-object/demo/reports \
  -H "content-type: application/json" \
  -d '{"topic": "durable execution"}'

# Inspect one run, or cancel it while it is parked.
curl http://localhost:8787/agents/report-object/demo/reports/<runId>
curl -X DELETE http://localhost:8787/agents/report-object/demo/reports/<runId>
```

The interesting part: start a run with a long hold (`"holdSeconds": 120`),
stop `wrangler dev` mid-hold, and start it again. Local Durable Object
storage persists across restarts, so the run resumes from its journal — the
draft step does not execute a second time, the sleep keeps its original
deadline, and the report still publishes.
