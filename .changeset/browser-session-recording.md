---
"agents": patch
---

Add Browser Run session recording to the browser tools. Set `recording: true`
on the connector's `session` option (or `ConnectBrowserOptions`/
`createBrowserSession`) to opt a session into an rrweb capture of everything
the agent did in the browser — DOM changes, input, and navigation — finalized
when the session closes. Pairs with Live View: watch a session live, then
review the recording afterward for audit or debugging. A new
`getBrowserRecording({ accountId, apiToken, sessionId })` helper fetches a
finished recording via the Browser Rendering REST API, returning per-tab rrweb
event arrays (`BrowserRecording`) ready for `rrweb-player`.
