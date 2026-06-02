# Browser Tools

**Status:** experimental (`agents/browser`)

## Problem

The browser tools need to expose the Chrome DevTools Protocol without shipping a large generated protocol bundle in the package, and they need to work the same way in local development and deployed environments.

## How It Works

The browser tools expose Chrome DevTools Protocol (CDP) access through a code-mode provider. The LLM never talks to the browser directly.

`createBrowserProvider()` contributes a `cdp` namespace to code mode. `cdp.spec()` fetches the protocol description from a live CDP endpoint and normalizes it into a compact search shape. `cdp.send()` and `cdp.attachToTarget()` dispatch commands through a browser-level CDP WebSocket opened from the host Worker. The sandbox issues RPC calls, while the actual WebSocket and browser session remain host-side.

When the Browser Rendering binding is available, the host uses the binding's devtools endpoints directly:

- `POST /v1/devtools/browser` to acquire a short-lived session for protocol fetches
- `GET /v1/devtools/browser` with `Upgrade: websocket` to acquire and connect for one-shot execution
- `POST /v1/devtools/browser?keep_alive=...` to create an opt-in reusable Browser Run session
- `GET /v1/devtools/browser/:sessionId` with `Upgrade: websocket` to reconnect to a reusable session
- `GET /v1/devtools/browser/:sessionId/json/protocol` to read the live protocol
- `DELETE /v1/devtools/browser/:sessionId` to release the session

`cdpUrl` remains as an override for custom CDP endpoints, but it is no longer the primary local-development path.

## Key Decisions

- Do not bundle the CDP spec in the package. The browser already exposes it, and fetching it at runtime avoids shipping a large generated asset plus a spec-generation build step.
- Normalize the live protocol before exposing it to the sandbox. The raw `/json/protocol` payload uses Chrome's schema (`domain`, command `name`, optional arrays). The tool prompt and user code are simpler when they always receive `name`, `method` or `event`, and concrete arrays.
- Keep browser state on the host side. The sandbox gets only RPC helpers, which preserves the existing code-mode isolation model and avoids giving arbitrary browser or network access to LLM-generated code.
- Use a fresh browser session per code-mode runtime by default. This keeps the lifecycle simple and makes cleanup deterministic.
- Support three browser session policies: `one-shot` for fresh per-runtime sessions, `reuse` for always-on reusable sessions, and `dynamic` for model-controlled persistence. In dynamic mode, execution remains one-shot until the model calls `cdp.startSession()` from the browser provider.
- Allow reusable Browser Run sessions only with the Browser Rendering binding. Reusable and dynamic modes store the Browser Run `sessionId`, reconnect a CDP WebSocket for each code-mode runtime, and expose `cdp.sessionInfo()`, `cdp.closeSession()`, and `cdp.resetSession()` from the same provider runtime so callers can manage lifecycle.
- Require reusable session stores to provide a per-key lock held for the full browser lease. This prevents two provider instances with the same key from creating competing Browser Run sessions or closing a session that another runtime has acquired.

## Tradeoffs

- Fetching the spec at runtime adds a small amount of latency compared with a bundled JSON file, so the implementation keeps a short in-memory cache.
- The cache is intentionally shallow and process-local. It reduces repeated fetches during a session without introducing persistence, invalidation complexity, or versioned assets.
- One-shot browser sessions make reasoning about cleanup easy, but longer workflows need to fit inside one tool invocation.
- Reusable and dynamic sessions support longer workflows but create lifecycle responsibility for the caller. If the caller does not close the session, Browser Run continues until its inactivity timeout.
- The Browser Rendering binding is now the default local-development path, which is much simpler for users, but it means local behavior depends on the Wrangler/Miniflare version providing the devtools endpoints.

## Verification

The end-to-end tests start a real `wrangler dev` instance, talk to an agent over WebSocket RPC, and exercise the provider against the local Browser Rendering binding. The suite covers:

- protocol search against the live `/json/protocol` endpoint
- simple browser commands such as `Browser.getVersion`
- page creation and navigation
- a DOM or runtime read after navigation
- representative error handling paths
