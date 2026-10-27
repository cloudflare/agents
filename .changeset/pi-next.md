---
"agents": minor
---

Support Pi 1.5 (`~1.5.0`; Pi 1.4 is no longer supported): `session.watch()` replaces `session.events()` and returns Pi's conversation view, `session.entries()` pages the transcript, `retry()` and the `parked` pending status are removed as Pi now ends crash-looping tasks, `submit()` takes `whenIdle: "reject"`, and the Pi tools build their schemas with `@earendil-works/pi-schema`, a new optional peer, as pi-ai no longer exports TypeBox's `Type`. See [pi-durable 1.5.0's changelog](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/CHANGELOG.md#150---2026-11-02).
