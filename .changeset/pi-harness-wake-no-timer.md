---
"agents": patch
---

`PiHarness`'s wake job no longer keeps a timer of its own. It used to hold a 10-minute wait on pi in memory, which kept the Durable Object awake, and billed, for as long as pi had a live task, even one that was only waiting. The job now only checks on pi: it stays due on its 30-second heartbeat while pi has live work, so an object that restarts mid-run is still brought back by its alarm, and it completes as soon as pi goes idle, leaving no alarm so the object can hibernate.
