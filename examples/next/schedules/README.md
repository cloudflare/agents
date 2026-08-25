# Next: schedules

An early-access, server-only example showing `Scheduler` from `agents/schedules`
installed on a plain Cloudflare `DurableObject`. It does not extend `Agent` or
another SDK base class.

```ts
export class ReminderObject extends DurableObject<Env> {
  readonly scheduler = new Scheduler(this);
  readonly lifecycle = Lifecycle.install(this).use(this.scheduler);

  deliverReminder(
    payload: { message: string },
    schedule: Schedule<{ message: string }>
  ) {
    // Runs when the schedule is due, with this object as `this`, even when the
    // alarm wakes a fresh instance.
  }

  async onRequest() {
    const schedule = await this.scheduler.set(5, "deliverReminder", {
      message: "ping"
    });
    return Response.json({ created: schedule });
  }
}
```

The Scheduler takes no wiring: storage, alarm coordination, host-callback
dispatch, and events all come from the Lifecycle it is installed on. It owns its
own `cf_agents_schedules` table and contributes its earliest pending row to
Lifecycle's shared physical alarm, so it composes with other capabilities that
also need wake-ups.

`set()` and `every()` type the payload against the named callback method.
`get()`, `list()`, and `cancel()` manage pending schedules. Delivered reminders
are recorded in the host's own SQL table, so both pending and completed work
survive the Durable Object leaving memory.

## Run

```sh
pnpm install
pnpm run dev
```

Exercise the named object `demo`:

```sh
# Create a one-shot reminder due in 5 seconds.
curl -X POST http://localhost:8787/agents/reminder-object/demo/reminders \
  -H "content-type: application/json" \
  -d '{"message": "stand up", "seconds": 5}'

# Or a recurring cron reminder (every minute).
curl -X POST http://localhost:8787/agents/reminder-object/demo/reminders \
  -H "content-type: application/json" \
  -d '{"message": "tick", "cron": "* * * * *"}'

# Pending schedules and delivered reminders.
curl http://localhost:8787/agents/reminder-object/demo

# Cancel a pending schedule by id.
curl -X DELETE http://localhost:8787/agents/reminder-object/demo/reminders/<id>
```

Wait a few seconds after creating a one-shot reminder, then fetch the object
again: the schedule row is gone and the reminder appears under `delivered`,
stamped by the scheduled callback.
