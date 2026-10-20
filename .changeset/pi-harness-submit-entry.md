---
"agents": patch
---

`PiHarness` `submit()` and `steer()` now accept pi-durable's `entry` option, which labels an input with a transcript kind of your own (for example `app.approval`) instead of `pi.user`. Before, the harness had no way to pass it. See [Label input the user did not type](https://developers.cloudflare.com/agents/harnesses/pi/#label-input-the-user-did-not-type).
