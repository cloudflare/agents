---
"agents": patch
---

Tasks: expose the attempt-wide abort signal to handler bodies, and bound a run by attempts and by wall-clock time.

- `step.signal` aborts for the whole attempt — on `cancel()` and when the run's `deadline` passes — so work awaited outside `step.do()` (a long model turn, a drain loop) can unwind. Inside a step the per-attempt signal already covered it.
- `run(name, input, { maxAttempts })` caps how many times a run is claimed (first attempt, replays after interruption, wakes from sleep or retry). The reclaim after the last permitted attempt fails the run with `TaskAttemptsExhaustedError` instead of running it again.
- `run(name, input, { deadline })` fails the run with `TaskDeadlineExceededError` when the wall-clock deadline passes: a parked run is woken at the deadline; a live attempt is settled over, its signal aborted, and its later writes fenced out.
- `onError(error, run)` now receives `{ runId, definition }`, and fires for every terminal failure including the ones Tasks records without running a handler (missing definition, exhausted budget, passed deadline). A failure whose settlement lost the generation fence is no longer reported, since the run was already settled and observed from elsewhere.
- Schema version 2 adds `max_attempts` and `deadline_at` to `cf_agents_task_runs`; existing objects migrate on their next start.
- A handler that catches the cancellation on `step.signal`, cleans up, and returns normally now settles the run `cancelled` rather than `completed`; the alarm memory-limit breaker's sealed failure now reaches `onError` like every other terminal failure; and a `deadline` at or before the epoch is refused at acceptance instead of stranding an accepted run behind a wake the queue rejects.
