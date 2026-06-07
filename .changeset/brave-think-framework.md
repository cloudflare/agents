---
"@cloudflare/think": patch
"agents": patch
"@cloudflare/worker-bundler": patch
---

Introduce the first Think framework layer for convention-driven agent apps.

This release adds a manifest-driven Vite plugin that discovers agents from the
`agents/` directory, generates a Worker entrypoint and virtual framework
modules, derives stable Durable Object class names, and merges framework-owned
Worker config defaults with user Wrangler config. It also keeps the Think Vite
plugin usable directly in normal Vite plugin arrays.

The framework now supports optional app server entries, manifest-scoped friendly
agent and sub-agent routing, deterministic route surfaces, colocated skill
detection, Worker Loader requirement diagnostics, and explicit diagnostics for
unsupported nested sub-agent conventions. Think currently supports top-level
agents and one sub-agent layer; deeper nesting is rejected with guidance so that
the routing and lifecycle model can be designed deliberately.

This framework layer is experimental: both the Vite plugin (once, on build
start) and the `think` CLI (on startup) emit a notice that the API may change
or be removed in any release. The core Think agent runtime is unchanged.

The Think CLI now includes `think init`, `think inspect`, and `think types`.
`think init` scaffolds a minimal Workers/Vite Think app, safely handles prompted
or named target directories, refuses unsafe migrations, and installs npm
dependencies by default. `think inspect` exposes manifest/config diagnostics in
text or JSON, while `think types` generates Think-owned declarations and can
optionally compose with Wrangler type generation.

This release also adds host-framework coverage for React Router and TanStack
Start, updates examples to use the convention-first framework shape, and hardens
Agents/worker-bundler virtual modules for bundled skill compatibility.
