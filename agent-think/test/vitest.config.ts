import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";
import { stripNodeModulesSourceMapReferences } from "../../scripts/vitest/strip-node-modules-source-map-references";

// FAST unit harness: runs the worker inside vitest-pool-workers (miniflare /
// workerd), NOT a real `wrangler dev`. This exercises the pure HTTP-surface
// logic in src/index.ts — help text, routing, 404s — with real bindings
// (ThinkAgent DO namespace, R2_SKILLS, AI, ASSETS) but WITHOUT the "container"
// backend, which cannot boot under miniflare. A full agent turn (submitMessages
// → container) is covered by the separate e2e suite; keeping it out of here is
// what makes this suite fast and deterministic.
const testDir = import.meta.dirname;

export default defineConfig({
  plugins: [
    // Silences noisy "can't resolve source map" warnings emitted while the
    // heavy dependency graph (@cloudflare/think, @cloudflare/workspace) is
    // pulled into the isolate. Shared monorepo helper, same as packages/agents.
    stripNodeModulesSourceMapReferences(),
    // The `agents` package ships a vite plugin that rewrites its client/runtime
    // entrypoints; src/index.ts imports `agents`, so the worker won't build in
    // the pool without it.
    agents(),
    cloudflareTest({
      // Keep everything local. The `AI` binding (Workers AI) has no local
      // implementation, so with remote bindings enabled the pool tries to open
      // a remote proxy session against the deployed worker — which sits behind
      // Cloudflare Access and fails in CI/non-interactive runs. This suite never
      // calls AI (that only happens inside a container turn), so disabling
      // remote bindings keeps startup hermetic and fast.
      remoteBindings: false,
      wrangler: {
        // A STRIPPED test config (no `containers`, no warm-pool cron) so
        // miniflare never tries to boot a Cloudflare Container or fire the
        // pool alarm — both of which throw "Failed to start container" here.
        // The container path is exercised by the e2e suite instead.
        configPath: path.join(testDir, "wrangler.jsonc")
      }
    })
  ],
  test: {
    name: "unit",
    include: [path.join(testDir, "**/*.test.ts")],
    // Provider routing is pure HTTP and runs in Node from the package test
    // script. The Workers pool's fetch bridge cannot observe both fallback
    // dispatches through an injected fetch implementation.
    exclude: [path.join(testDir, "model.test.ts")],
    setupFiles: [path.join(testDir, "setup.ts")],
    // The first module resolution in the isolate has to load think + workspace;
    // 15s keeps a cold start from tripping a spurious timeout.
    testTimeout: 15_000,
    // Tearing down workers-pool isolates can outrun vitest's default and surface
    // as "Worker exited unexpectedly" (an infra teardown race, not a real
    // failure). Give the pool room to terminate cleanly.
    teardownTimeout: 60_000,
    deps: {
      optimizer: {
        ssr: {
          // ai / think pull in ajv, which needs SSR-optimizing to load cleanly
          // inside the pool isolate.
          include: ["ajv"]
        }
      }
    }
  }
});
