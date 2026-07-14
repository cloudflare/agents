# Cloudflare demo

Run from the repo root:

```bash
npm run demo:cf
```

Open the local Wrangler URL and chat with `/agents/demo-agent-do/default`.
Try normal chat, `email bob` for an approval-gated action, and
`write a note about launch notes` for the workspace `write` tool.
Kill and restart `wrangler dev`, then reconnect to see persisted history.
By default the worker uses the offline scripted model. Set
`ANTHROPIC_API_KEY` as a Wrangler secret or dev var to use Anthropic; set
`DEMO_MODEL` to override the default `claude-opus-4-8` model.
Without an Anthropic key, the demo uses the Workers AI binding when available;
run `wrangler login` first because local dev proxies binding calls to the real
service. Set `WORKERS_AI_MODEL` to override the default
`@cf/moonshotai/kimi-k2.7-code` Workers AI model. If both Anthropic and
Workers AI are configured, the Anthropic key wins.
