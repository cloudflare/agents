---
"agents": patch
---

Keep `browserTool`'s active tab per scope, so conversations sharing one `Browser` don't drive each other's tab.

- `browserTool` (AI SDK and TanStack AI) takes `scope?: string`. Each scope has its own active tab, while cookies and logins stay shared. Leaving it out uses the `"shared"` scope, as before.
- `Browser.connect({ scope })` returns the scope's `activeTargetId`, and `restarted` is now reported to every scope that worked in the lost browser, not only to the caller that found it gone.
- A scope with no tab claims an unused blank tab or opens a new one, instead of taking the first open tab.
- Runs in one scope are queued; runs in different scopes run in parallel.
- Popups are reported to the run whose page opened them, and the result's `notice` says when another scope closed or is using the model's tab.
- Breaking for the experimental API: `ResolvedBrowser` no longer carries `activeTargetId`, and `BrowserConnection` gains `scope`, `claimTarget`, and `targetsInOtherScopes`.
