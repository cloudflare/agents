---
"agents": patch
---

Make queue and schedule getter methods synchronous

`getQueue()`, `getQueues()`, `getSchedule()`, `dequeue()`, `dequeueAll()`, and `dequeueAllByCallback()` were unnecessarily `async` despite only performing synchronous SQL operations. They now return values directly instead of wrapping them in Promises. This is backward compatible — existing code using `await` on these methods will continue to work.
