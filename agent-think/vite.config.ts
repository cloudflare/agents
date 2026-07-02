import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds ONLY the read-only thread UI (a small React SPA) into
// `dist/client`, which wrangler serves as static assets (see the
// `assets` binding in wrangler.jsonc). The worker itself — the
// AgentThink RPC entrypoint, the ThinkAgent DO, the container
// backend — is built by wrangler from `src/index.ts`, not Vite, so
// the container image build is unaffected.
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

// `@cloudflare/ai-chat/react` (and `@cloudflare/think/react`) import
// `agents/chat/react`, but the workspace `agents` package.json omits that
// subpath from its `exports` map even though the built file exists. The
// exports gate blocks resolving the subpath directly, so resolve the package
// root (via its package.json) and join the built file path. (Pre-existing
// monorepo gap; scoped here rather than editing the shared package.)
// `agents` main resolves to <root>/dist/index.js; go up two to the package root.
const agentsMain = require.resolve("agents");
const agentsChatReact = path.join(path.dirname(agentsMain), "chat/react.js");

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "agents/chat/react": agentsChatReact
    }
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true
  }
});
