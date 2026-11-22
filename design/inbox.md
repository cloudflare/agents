# Inbox

**Internal.** Not a public API. Nothing new from the slim-hosts work is exposed to apps until it has shipped inside `Think` and `AIChatAgent` for a release and is shown correct ([rfc-slim-hosts.md](./rfc-slim-hosts.md#exposure)). Sibling packages import it from `agents/internal`.

`Inbox` (`packages/agents/src/inbox`) keeps one durable record for every request waiting to run on a Durable Object, and runs those requests one at a time per lane. It is a Lifecycle capability built on the Lifecycle job queue.

Status: implemented. Internal.

## Why it exists

Before it, a request waiting to run was stored three ways: chat admissions (`cf_agents_chat_admissions`), Think's programmatic submissions (`cf_think_submissions`) and the agent-tool run table (`cf_agent_tool_runs`). Each had its own idempotency, status vocabulary, waiter maps and reset handling, and the chat turn order lived in memory in `TurnQueue`, `SubmitConcurrencyController` and `AbortRegistry`. The inbox is the one place that answers "what is waiting, in what order, and how did each request end".

## How it works

A request is a row in `cf_agents_inbox`: id, a token, kind (the handler that runs it), lane, arrival `seq`, status, attempt, policy, idempotency key, metadata, progress, result, error and timestamps. The token is unique to the record: an id can be deleted and submitted again, and every write the lane runner makes, every local value and every waiter is keyed by the token, so a late write for the old record never touches the new one. A payload, result or progress longer than 160,000 UTF-16 units is split across `cf_agents_inbox_parts`, never between the halves of a surrogate pair, and metadata is capped at 100,000, so the whole row stays under SQLite's 2 MB limit.

Status is `pending`, `running`, `completed`, `error`, `aborted` or `skipped`. The last four are terminal, and a terminal status never changes: every status write is guarded in SQL on the status (and the attempt) it expects. Progress is not status and stays writable, because some facts land after a request ended (Think learns a cancelled turn's message id after the cancel).

Each kind has a handler registered in the constructor. A handler gets the payload and a run (`id`, `kind`, `lane`, `attempt`, `signal`, `metadata`, `progress`, `merged`). It returns the result, throws (`error`, no retry), or returns `Inbox.aborted()`, `Inbox.skipped()`, `Inbox.failed()` or `Inbox.detached()`. A detached request stays `running`, frees its lane, and is never run again: something else ends it with `settle()`. Think uses that while chat recovery, not the inbox, owns a recovered turn.

### Lanes and order

A lane runner is an in-memory loop. It reads the oldest open request of its lane (by `seq`, detached ones left out), runs it, and reads again. One lane runs one handler at a time; lanes run side by side. A cancel or clear does not free the lane before the cancelled handler returns: the handler gets an aborted signal, and the next request starts once it has unwound.

### Policies

A request's policy is decided when it arrives and stored on its row, so it holds across a reset.

| Policy           | Lane idle | Lane busy                                                                 |
| ---------------- | --------- | ------------------------------------------------------------------------- |
| `queue`          | runs      | waits its turn                                                            |
| `drop`           | runs      | ends `skipped` at once                                                    |
| `latest`         | runs      | overlapping: skipped at the front when a later overlapping request exists |
| `merge`          | runs      | as `latest`; the survivor's `run.merged` names the requests it superseded |
| `{ debounceMs }` | runs      | as `latest`, and waits at the front until `debounceMs` after it arrived   |

Supersession is decided at the front of the lane, never on arrival, and only by a later request that is still open: one that already ended ran (or was cancelled) without the earlier one's input. The survivor's row keeps the ids it superseded with their arrival `seq`, so `run.merged` is whole and in arrival order even when the skipped records are gone or the survivor changed while a skip was being reported. A superseded request's `onStatus` therefore runs in lane order, after the request ahead of it ended. Chat needs that: a superseded request's question is stored when its turn would have started, not while the turn ahead of it still streams. This is the same rule `SubmitConcurrencyController` had, with the sequence numbers replaced by the stored `overlap` flag and `seq`.

### Cancel and clear

`cancel(id)` ends a pending request `aborted`, or a running one `aborted` while aborting its signal. `clear(lane)` ends every open request of the lane `skipped`, detached ones included. Clear is the generation bump the in-memory queue had. No generation counter is needed because terminal is final.

### Resets and the wake job

The job queue holds one job per lane with an open request (`<capability id>/lane:<lane>`). Submit writes it in the same synchronous block as the row, due now (or, with `start: "now"`, 30 seconds out, and starts the runner in the calling invocation), so a reset during the `pending` report still runs the request. The runner waits for reports started outside it (a submit's `pending`, a cancel's terminal one) before it reads the lane again, so a handler never starts before its request's `pending` report returned. While a handler runs, the job sits 30 seconds ahead. Each time it fires with the lane running here, it hands the runner to `trackAlarmWork` and moves forward again. That keeps the object awake through a long handler (the interval `keepAlive()` uses), keeps the handler inside the alarm memory-limit breaker, and leaves a wake that survives the isolate. When the lane has nothing open the runner cancels the job, in the same synchronous block as the read that found the lane empty, so a submit cannot slip in between and lose its wake.

On start, every lane with open requests gets its wake due now. Only the lane's runner starts handlers, so a `running` row the runner reads was interrupted: its isolate died. It runs again with `attempt + 1`, ahead of the requests behind it, which then replay in order. Past `maxAttempts` (default 3) it ends `error`. A pending record that already carries attempts (an imported one) starts at its next attempt, or ends `error` when its attempts are spent. A result is serialized once per write; the stored JSON is that serialization. The attempt is written and synced (`storage.sync()`) before the handler runs: a reset before the next I/O would otherwise roll it back, and a handler that kills its isolate would never use up its attempts. `settle()` falls back to `error` too when its outcome cannot be stored. An outcome that cannot be stored (a result that does not serialize, a write that fails) ends the request `error` instead of leaving it `running`; error text is cut at 10,000 characters. Handlers run at least once, never exactly once; `checkpoint()` lets an attempt leave notes the next attempt reads as `run.progress`. A platform failure in a handler or a report (a memory-limit or code-update reset) is not an application error: the request stays `running` and the error goes on to the alarm breaker, which counts it.

### Idempotency

A submit whose id or idempotency key names an existing record returns it with `accepted: false` when the kind and stored payload JSON are the same, and throws when they differ. An id and a key that name two different records throw. A repeated submit of an open request also re-pushes its lane's wake, so a caller that retries after losing track of a request also recovers a lost wake.

### Status hook and waiters

`onStatus` runs on every transition (`pending` on submit, `running` on every attempt, terminal), awaited in host context. `wait(id)` resolves after the terminal `onStatus` returned, never before. Waits live in memory and die with the isolate; the record does not, so a caller waits again after a reset.

The terminal report is at least once. When the terminal `onStatus` returns, the row's `notified` column takes the status. On start, terminal rows whose `notified` is behind get their `onStatus` again, from a `report` job that hands the replay to `trackAlarmWork` so user code does not hold the job loop. `wait()` and `isSettled()` treat such a row as not settled until its replayed report returned. A report that fails with a platform failure leaves the row unreported and its waiters waiting, and queues the replay 30 seconds out (a record deleted meanwhile answers its waiters with what it ended with instead); a clear whose report fails releases the reports it had not started and queues them too. The `report` job stays, 30 seconds out, until the replay finds nothing left, and the replay reports a row only if it is still the same record (by token), terminal and unreported. A host can therefore do durable work from the terminal report (Think queues the workflow notification there) without writing it in the same transaction as the status.

`import()` writes a record moved from another store as it was, for one-way migrations. An imported `running` record counts as interrupted and runs again; an imported terminal record is marked reported.

### Named inboxes, retention, local values and held lanes

- `new Inbox({ name })` keeps its rows in `cf_agents_inbox__<name>`, so a library's inbox (the chat turn core's) never meets the app's. Its capability id is `inbox:<name>`, and its job ids carry that id, because job ids are one space across capabilities.
- `retain: false` deletes a record once its terminal report ran and its waiters were answered. Chat requests need no record after they end.
- `submit(..., { local })` keeps a value in memory beside the record and hands it to the handler as `run.local`: a callback that cannot be stored, such as `saveMessages(fn)`. After a reset the handler runs without it and decides from the record alone.
- `hold(lane)` makes the lane's requests from an earlier isolate (those without a local value) wait, while requests submitted in this isolate still run in order among themselves. `release(lane)` lets the waiting ones run. A host holds a lane while work that is not in the inbox yet must go first after a reset (chat recovery, until recovery is the inbox's own re-run). While a held lane waits, its runner stays in memory and its wake job keeps the object awake.

### Events

`inbox:submit`, `inbox:status` (every transition), `inbox:retry` (an interrupted request runs again), `inbox:error`.

## What is durable and what is not

Durable: the row and its parts, the policy decision, the debounce deadline, attempt, progress, result, error, whether the terminal status was reported, and the lane's wake job. In memory: the lane runners, the running handlers' abort controllers, debounce timers, and `wait()` promises. A terminal `onStatus` cut short by a reset runs again; a `pending` or `running` one does not.

## Tradeoffs

- The inbox is on the job queue, not on Tasks. A request is one handler call ordered against other requests in its lane; Tasks journals the steps of one long run and has no order between runs. A handler that needs a step journal can start a Task.
- Retention is explicit. Terminal records stay until `delete()` or `purgeBefore()`. Hosts that keep records only while a request waits (chat admissions) purge on settle.
- `start: "alarm"` is the default so a submit returns before any handler runs, and the handler runs in an alarm invocation that owns it. The cost is one alarm dispatch of latency.
- A handler that ignores its abort signal holds its lane until it returns. The inbox cannot abandon owner code safely.
