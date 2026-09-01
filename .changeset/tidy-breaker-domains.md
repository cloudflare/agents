---
"agents": minor
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Make the alarm memory-limit circuit breaker (#1825) a self-contained
Lifecycle concern instead of an Agent-mediated one.

Recovery-loop membership is now a property of the job row
(`LifecycleJobPushOptions.recoveryLoop`): flagged jobs are backed off by
the breaker on a strike and purged when it seals at the strike budget,
without disturbing unrelated rows — a recovery schedule can no longer
silently escape the breaker. The public `ScheduleOptions` vocabulary is
unchanged: schedules only shape future work, and chat recovery reaches the
flag through internal scaffolding (`RecoveryLoopScheduleOptions`) that will
be deleted when recovery migrates onto the Tasks capability, where
OOM-prone loops belong.
Capabilities can react to a strike through the new optional `onMemoryLimit`
hook, hosts through `onAlarmMemoryLimit`, and the context identifies the job
that was executing when one exists. The strike budget is real Lifecycle
configuration (`Lifecycle.install(host, { maxAlarmMemoryLimitStrikes })`)
rather than a composition-root side channel. Until chat recovery moves to
Tasks, a sealed routed recovery schedule also forwards the seal to its owning
dynamic agent so a chat child under a plain Agent root persists its exhausted
incident and terminal notification.

Removed accordingly: `Agent.onAlarmMemoryLimit`'s policy relay, the
`_cf_recoveryAlarmCallbacks` template hook, `Scheduler.applyMemoryLimitPolicy`,
and
`setLifecycleAlarmMemoryLimitStrikes`. `AIChatAgent` and `Think` flag their
recovery schedules via `chatRecoverySchedulePolicy` and seal in-flight
incidents from their own protected `onAlarmMemoryLimit` hooks; both now
require `agents >= 0.23.0` (they consume new `agents/chat` exports and no
longer implement the old template-method breaker hooks). Agent retains a
sealed-only call to `_cf_sealMemoryLimitedRecovery` so already-published chat
packages whose peer ranges accept agents 0.23 keep terminal notifications;
that fallback carries no callback-name or queue policy.
