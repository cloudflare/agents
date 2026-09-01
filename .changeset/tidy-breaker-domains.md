---
"agents": minor
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Make the alarm memory-limit circuit breaker (#1825) a self-contained
Lifecycle concern instead of an Agent-mediated one.

Recovery-loop membership is now a property of the job: schedules created
with the new `recoveryLoop` option (and jobs pushed with the matching
`LifecycleJobPushOptions` flag) are backed off by the breaker on a strike
and purged when it seals at the strike budget, without disturbing unrelated
rows — a new recovery schedule can no longer silently escape the breaker.
Capabilities can react to a strike through the new optional `onMemoryLimit`
hook, hosts through `onAlarmMemoryLimit`, and the strike budget is real
Lifecycle configuration (`Lifecycle.install(host, { maxAlarmMemoryLimitStrikes })`)
rather than a composition-root side channel.

Removed accordingly: `Agent.onAlarmMemoryLimit`'s relay implementation, the
`_cf_recoveryAlarmCallbacks` / `_cf_sealMemoryLimitedRecovery` template
methods, `Scheduler.applyMemoryLimitPolicy`, and
`setLifecycleAlarmMemoryLimitStrikes`. `AIChatAgent` and `Think` flag their
recovery schedules via `chatRecoverySchedulePolicy` and seal in-flight
incidents from their own protected `onAlarmMemoryLimit` hooks.
