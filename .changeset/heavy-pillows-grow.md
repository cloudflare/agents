---
"create-think": minor
---

Add `webhook-agent` and `business-workflow` starter templates.

`webhook-agent` scaffolds an agent fed by inbound webhooks through durable,
idempotent submissions (a custom `src/server.ts` entry + `submitMessages`).
`business-workflow` scaffolds a back-office operations agent with
human-in-the-loop approval gates (`needsApproval` + an approval UI) and a
scheduled digest. Every starter now also ships a `start.md` you can paste into an
AI coding agent for guided setup.
