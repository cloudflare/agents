---
"agents": patch
---

remove unstable\_ prefixes with deprecation warnings

This deprecates all unstable\_ prefixes with deprecation warnings. Specifically:

- unstable_callable -> callable
- unstable_getAITools -> getAITools
- unstable_getSchedulePrompt -> getSchedulePrompt
- unstable_scheduleSchema -> scheduleSchema

Using the unstable\_ prefixed versions will now emit a deprecation warning. In the next major version, the unstable\_ prefixed versions will be removed.
