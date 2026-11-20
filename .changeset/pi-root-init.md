---
"agents": minor
---

`PiHarness` creates the root session on its first use instead of when Pi opens, and `harness.root({ agent, init })`, `sessions.create({ agent, init })` and `sessions.fork(from, { agent, init })` take Pi's `init`, so a session can start from an existing history. See [Seed a session with an existing history](https://developers.cloudflare.com/agents/harnesses/pi/#seed-a-session-with-an-existing-history).
