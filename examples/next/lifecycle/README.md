# Lifecycle job-queue demo

A plain Durable Object composed with `agents/lifecycle`, exercising the
Lifecycle-owned job queue against real platform failure: instance restarts,
simulated memory-limit strikes (the alarm circuit breaker), and genuine
out-of-memory isolate deaths.

## Deploy

```sh
npm run deploy
```

## Drive it

All routes live under `/agents/do-agent/<name>` on the deployed worker:

| Route | What it does |
| --- | --- |
| `/status` | Isolate id, strike counter, counters, pending jobs, armed alarm, recent log |
| `/start` (POST) | Push a durable `tick` job that reschedules itself every 5s |
| `/stop` (POST) | Cancel the tick job; an empty queue deletes the alarm and hibernates |
| `/restart` (POST) | `ctx.abort()` the instance; the tick job resumes on the next wake |
| `/oom` (POST) | Push a job whose dispatch throws the platform memory-limit error; watch the breaker strike (backoff 30s, 60s), then seal and purge it at strike 3 while ticks keep running |
| `/oom-real` (POST) | Push a job that genuinely allocates until the isolate dies, twice; the platform retries the alarm on fresh isolates and the third run completes |

The `/status` log records which in-memory isolate wrote each entry, so
restarts and OOM deaths are visible as isolate-id changes while the durable
counters and jobs carry straight through them.
