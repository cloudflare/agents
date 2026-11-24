---
"agents": patch
---

The MCP client checks server URLs with the same rules as `web_fetch`, and applies them to every request it sends (OAuth discovery and token requests, the SSE stream, followed redirects). It now also refuses IPv6 forms of private IPv4 addresses (NAT64, 6to4, IPv4-compatible), IPv6 site-local and multicast, carrier-grade NAT and other reserved IPv4 ranges, names ending in `.internal`, and URLs that carry credentials or are not http(s); loopback stays allowed. See [URL security](https://developers.cloudflare.com/agents/model-context-protocol/apis/client-api/#url-security).
