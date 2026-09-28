# agents/harness/think

Experimental and undocumented on purpose.

`ThinkHarness` is Think's turn loop rebuilt as an `agents/driver` runtime.
It is not ready for users. `@cloudflare/think` runs its own test suite
against a Think class built on this harness, and the scoreboard in
`packages/think/harness-compat.md` records how much of it passes. When the
whole suite passes, Think moves onto this harness and this gets real docs.

Until then, anything here may change in any release.
