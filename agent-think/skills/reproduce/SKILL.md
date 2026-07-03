---
name: reproduce
description: Reproduce a cloudflare/agents GitHub issue by scaffolding a minimal Agents/Worker project and deploying it to a temporary Cloudflare account, then report findings back on the issue.
---

You are given `issueNumber`, `repo`, and `context` in the arguments. Reproduce the bug end-to-end and post your findings as an issue comment.

`context` is any free-form text the user typed after the `@agent-think repro`
command (it may be empty). Treat it as an extra hint from the triggering user
— e.g. additional reproduction steps, a specific version, or a pointer to the
suspect area. Let it guide your reproduction, but the issue itself remains the
source of truth.

All `gh`, `git`, `npm`, `curl`, and `wrangler` commands must run on the
`container` backend (`exec({ command, backend: "container" })`) — the `shell`
backend has no real binaries or network. `gh` is already authenticated as the
app; use it directly (no token handling).

## 0. Clone the repo

The workspace starts empty. Clone the target repo into `/workspace/repo` first:

```bash
git clone --depth=1 https://github.com/<repo>.git /workspace/repo
```

## 1. Understand the issue

```bash
gh issue view <issueNumber> --repo <repo> --json title,body,labels,comments
```

Read it carefully. Extract:

- the **observed behavior** (the bug),
- the **expected behavior**,
- any **"To Reproduce" steps**, code snippets, versions, or stack traces.

**Decide if it is reproducible at all.** If it is a feature request, a question,
a pure-docs issue, or has no concrete runnable behavior, stop here: return
`skipped: true`, `reproduced: false`, and a `summary` explaining why. Still post
a short, polite comment saying the repro-agent skipped it and why.

## 2. Understand the relevant code

With the repo cloned at `/workspace/repo`, read the relevant parts of
`packages/agents`, `packages/think`, or the matching `think-starters/` template
to understand the area the issue touches. Match the user's versions where it
matters.

## 3. Scaffold a minimal reproduction

Work in a scratch dir **under `/workspace`**, never touch the checkout. Do NOT
use `/tmp` or any path outside `/workspace`: only `/workspace` is the shared
filesystem that both the container shell AND the `read`/`write`/`edit` tools
see. Files written elsewhere are invisible to those tools.

```bash
REPRO_DIR="/workspace/repro-<issueNumber>"
mkdir -p "$REPRO_DIR"
cd "$REPRO_DIR"
```

Build the **smallest** project that can exhibit the bug — but every repro
ships a **minimal Vite frontend** (next section) so a maintainer can click the
deployed link and watch the issue happen in a UI. Keep the _backend_ tight:
only the agent/worker code the bug needs, no auth, nothing unrelated. For
think-related bugs, lift the relevant backend logic from the closest
`think-starters/` template (e.g. `coding-agent`, `basic`) into the project
shape below — the shape itself is non-negotiable.

If the bug needs extras (`@cloudflare/think`, `worker_loaders` for the execute
tool, `ai`/KV bindings, …), add them to `package.json`, `wrangler.jsonc`, and
`Env` on top of the base recipe. Use **today's `compatibility_date`**
(`date +%Y-%m-%d`) unless the issue pins a version where the date matters.

### Minimal frontend (required)

Every repro deploy MUST ship a minimal Vite + React page at the Worker's root URL so a human can open the deployed link, click a trigger button, and watch the failing behavior in visible output (status line / log area showing expected vs. actual). House style: one flat project, `@cloudflare/vite-plugin` (runs `src/server.ts` in workerd during dev, emits client + worker builds), agents SDK routing, Workers Assets with SPA fallback.

**Steps**

1. In `$REPRO_DIR`, create the 7 files below.
2. `npm install > /tmp/install.log 2>&1; tail -15 /tmp/install.log` (pin `agents` to the exact version under test if the bug is version-specific). Always redirect noisy commands to a container-local file like this — streaming megabytes of live output through the session can kill it.
3. Sanity-check the build before deploying: `npx vite build` (catches config errors cheaply; do NOT run `vite dev` — it blocks waiting for a browser).
4. Deploy per the **Deploy** step below (`vite build` first is mandatory; the build writes `dist/` plus a `.wrangler/deploy/config.json` redirect that `wrangler deploy` follows).
5. After deploy, confirm the root URL serves the page (the **Verify** step) and include the URL + click instructions in your report (the **Report back** step).

**package.json**

```json
{
  "name": "<APP_NAME>",
  "type": "module",
  "private": true,
  "scripts": {
    "start": "vite dev",
    "deploy": "vite build && wrangler deploy --temporary"
  },
  "dependencies": {
    "agents": "<VERSION_UNDER_TEST e.g. ^0.16.2>",
    "react": "^19.2.7",
    "react-dom": "^19.2.7"
  },
  "devDependencies": {
    "@cloudflare/vite-plugin": "^1.40.2",
    "@cloudflare/workers-types": "^4.20260612.1",
    "@types/node": "^25.9.3",
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^6.0.2",
    "typescript": "^6.0.3",
    "vite": "^8.0.16",
    "wrangler": "^4.100.0"
  }
}
```

**vite.config.ts** — add `agents()` from `"agents/vite"` FIRST in the plugin list only if the server uses `@callable()` decorators (rolldown/oxc can't transform them without it).

```ts
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({ plugins: [react(), cloudflare()] });
```

**index.html** — must sit at project root; script src is the raw TS path.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title><APP_NAME></title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/client.tsx"></script>
  </body>
</html>
```

**src/client.tsx**

```tsx
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";

function App() {
  const [log, setLog] = useState<string[]>([]);
  const add = (m: string) => setLog((l) => [...l, `${new Date().toISOString()} ${m}`]);
  const agent = useAgent({
    agent: "<kebab-case-of-binding>", // e.g. binding ReproAgent -> "repro-agent"
    name: "demo",
    onOpen: () => add("ws connected"), onClose: () => add("ws closed"),
    onMessage: (e) => add(`recv: ${e.data}`)
  });
  return (
    <main style={{ fontFamily: "monospace", padding: 16 }}>
      <h1><ISSUE_REF_AND_TITLE></h1>
      <p>Expected: <EXPECTED>. Actual (bug): <ACTUAL>.</p>
      <button onClick={async () => {
        add("trigger");
        // <TRIGGER: agent.call("<method>", [...]) for @callable, agent.send(...),
        //  or fetch("/agents/<kebab-case-of-binding>/demo") for onRequest repros>
      }}>Trigger bug</button>
      <pre>{log.join("\n")}</pre>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
```

**src/server.ts**

```ts
import { Agent, routeAgentRequest } from "agents";

type Env = { <AGENT_CLASS>: DurableObjectNamespace<<AGENT_CLASS>> };

export class <AGENT_CLASS> extends Agent<Env> {
  // <REPRO: @callable() methods / onRequest / onConnect / onMessage / state ops>
}

export default {
  async fetch(request: Request, env: Env) {
    return (await routeAgentRequest(request, env)) || new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
```

**wrangler.jsonc**

```jsonc
{
  "name": "<APP_NAME>",
  "main": "src/server.ts", // TS source; the Vite plugin builds it
  "compatibility_date": "2026-06-11",
  "compatibility_flags": ["nodejs_compat"], // required by agents SDK
  "assets": {
    // NO "directory" key: @cloudflare/vite-plugin supplies the client build output
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/agents/*"] // + any extra Worker routes the repro adds
  },
  "durable_objects": {
    "bindings": [{ "name": "<AGENT_CLASS>", "class_name": "<AGENT_CLASS>" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["<AGENT_CLASS>"] }]
}
```

**tsconfig.json**

```json
{ "extends": "agents/tsconfig" }
```

**Rules (violating any of these breaks the deploy)**

- Never set `assets.directory` and never run plain `wrangler dev`/`wrangler deploy` without `vite build` first — the Vite plugin owns the client output and generated config.
- `run_worker_first` is an allowlist: paths not listed get the SPA fallback (index.html), so agent HTTP/WS routes under `/agents/*` (and any custom Worker paths) must be listed.
- Keep DO `name` == `class_name`; the client's `agent:` id is its kebab-case (`routeAgentRequest` serves `/agents/<kebab-binding>/<instance>`, HTTP + WebSocket).
- `migrations` must use `new_sqlite_classes` (Agents require SQLite-backed DOs); `"type": "module"` in package.json is required.
- Hand-written `type Env` is fine; `npx wrangler types env.d.ts --include-runtime false` regenerates it after binding changes.
- If the bug needs extra bindings (`ai`, KV, etc.), add them to wrangler.jsonc and `Env` — everything else stays as above.

## 4. Deploy to a temporary Cloudflare account

The shell has **no** Cloudflare credentials, so use the temporary-account flow
(requires wrangler >= 4.102.0). `vite build` must run first — it produces the
client assets and the deploy-config redirect wrangler follows:

```bash
npm run deploy   # = vite build && wrangler deploy --temporary
```

This creates/reuses a temporary preview account and deploys to a
`*.workers.dev` URL. Capture the live `https://...workers.dev` URL from the
output → `liveUrl`. Ignore the claim URL the deploy prints — it never goes in
a report.

If the build/deploy itself fails in a way that **is** the bug, that is a valid
reproduction — record the exact error. If it fails for an unrelated reason, fix
the scaffold and retry (do not change SDK source).

## 5. Verify the reproduction

Actually exercise the deployed worker and confirm the reported symptom. First
check the frontend is up, then hit the buggy path the same way the UI's
trigger button does:

```bash
curl -sS -i "<liveUrl>/" | head -5          # 200 + HTML = frontend serving
curl -sS -i "<liveUrl>/agents/<kebab-binding>/demo<path-that-triggers-the-bug>"
```

Compare against the expected behavior. Only set `reproduced: true` if you
observed the bug (wrong output, error, crash, etc.). If it behaves correctly,
set `reproduced: false` and explain — the issue may be fixed, version-specific,
or need more detail. Either way the deployed page must demo the behavior a
human should look at.

## 6. Push the repro to a branch

Publish the repro project as an **orphan branch on the target repo** so anyone
(human or agent) can pull exactly what you built and run it:

Never do this inside `/workspace/repo` — the clone must stay intact for the
root-cause hypothesis and any follow-up PR work. Publish from a scratch dir:

```bash
PUBLISH_DIR="/workspace/repro-publish-<issueNumber>"
mkdir -p "$PUBLISH_DIR" && cd "$PUBLISH_DIR"
git init -q -b repro/issue-<issueNumber>
tar -C "$REPRO_DIR" --exclude node_modules --exclude dist \
  --exclude .wrangler --exclude .env -cf - . | tar -xf -
git add -A
git commit -q -m "repro for #<issueNumber>: <one-line issue title>"
git push -f https://github.com/<repo>.git HEAD:repro/issue-<issueNumber>
cd /workspace && rm -rf "$PUBLISH_DIR"
```

- The scratch `git init` publishes an orphan branch with no base-repo
  history; the checkout IS the runnable repro
  (`git clone -b repro/issue-<issueNumber> ... && npm install && npm run deploy`).
- One canonical branch per issue: re-runs force-push the same
  `repro/issue-<issueNumber>` branch.
- Capture `https://github.com/<repo>/tree/repro/issue-<issueNumber>` as
  `reproBranchUrl`. If the push is rejected (branch protection), say so in the
  report and continue — the branch is best-effort, the report is not.

## 7. Report back on the issue

Post a comment with `gh`. Build the body in a file to keep formatting clean:

```bash
gh issue comment <issueNumber> --repo <repo> --body-file comment.md
```

The comment should contain:

- **Verdict**: reproduced / could not reproduce / skipped, with one-line reason.
- **Live URL** plus one line of click instructions ("open it, press _Trigger
  bug_, watch the log") — the page is the demo. Phrase it exactly like:
  "Repro URL (expires after 60 mins): <liveUrl>".
- **Repro branch**: the `reproBranchUrl` link — "pull this branch to run the
  repro yourself". This is what other agents check out to build on your work.
- **Minimal repro**: the key files (`wrangler.jsonc` + the agent/worker source) in fenced code blocks, or a short `git`-style listing.
- **What you observed** vs. **expected**, including relevant curl output / errors.
- **Root-cause hypothesis** if you have one (point at the suspect file/line in `packages/`).
- A short "🤖 generated by the repro-agent" footer.

Capture the returned comment URL for `commentUrl`.

## 8. Return the structured result

Return exactly:

- `reproduced` (boolean)
- `skipped` (boolean)
- `summary` (string — one or two sentences)
- `liveUrl` (string, optional)
- `reproBranchUrl` (string, optional)
- `rootCauseHypothesis` (string, optional)
- `commentUrl` (string, optional)
