# Think Slide Deck

A Think-powered slide deck generator that uses `@cloudflare/shell` as the
durable source filesystem and `@cloudflare/worker-bundler` to produce a live
React preview. It is a container-free port of the core Let It Slide idea.

## What It Demonstrates

- **Think as the agent runtime** — chat, streaming, durable messages, tool
  execution, and workspace tools come from `@cloudflare/think`.
- **Shell Workspace as source of truth** — slide files live in the agent's
  durable Workspace instead of a Linux container filesystem.
- **Worker Bundler as renderer** — the Worker materializes the workspace, generates
  a static slide registry, bundles the React preview app, and serves it through
  Worker Loader.
- **Native app UI** — the chat, preview, and source panel are built directly with
  Kumo instead of embedding OpenCode in an iframe.
- **Let It Slide visual systems** — new workspaces are seeded with workers.dev
  layouts, CF 2026-inspired corporate templates, branded icon primitives,
  diagram/mockup helpers, reference recipes, and fixed 1200×675 slide geometry.

## Run It

```sh
cd examples/think-slide-deck
npm install
npm start
```

The example uses the Workers AI binding with `"remote": true`, so `wrangler`
must be authenticated to an account with Workers AI access.

Open the app and ask for a deck, for example:

```text
Make a three-slide deck about why Think is useful for generated apps.
```

## Architecture

```text
Browser
  ├─ /agents/SlideDeckAgent/:name  -> Think chat protocol
  └─ /preview/:name/*              -> bundled deck preview

SlideDeckAgent
  ├─ Think workspace               -> /src/slides/*.tsx, components, CSS
  ├─ saveSlide/buildDeck tools     -> slide-specific authoring surface
  ├─ worker-bundler createApp()    -> React preview bundle
  └─ Worker Loader                 -> serves the built preview iframe
```

The generated preview does not use Vite or `import.meta.glob`. During
`buildDeck()`, the agent uses `createGeneratedApp()` with a Workspace-backed
`SourceProvider`, generated overlays for `src/registry.ts` and host assets, and
Worker Loader preview serving. `saveSlide()` schedules a debounced rebuild and
`buildDeck()` forces an immediate rebuild, with preview versions persisted on
successful builds.

The workspace is seeded with:

- `/STYLE_GUIDE.md` and `/REFERENCE_SLIDES.md` — condensed Let It Slide design
  guidance, style-mode rules, and deck recipes for the Think agent to read
  before authoring slides.
- `/src/components.tsx` — export-safe slide primitives such as `SlideFrame`,
  `SlideHeader`, `Pill`, `BigTitle`, `Lead`, `FeatureCard`, `Stat`,
  `CodeBlock`, and expressive workers.dev layouts.
- `/src/cf2026.tsx` — a dependency-free subset of the Cloudflare 2026 template
  vocabulary: orange/white covers, divider, content columns, stats, icon rows,
  native grids, copy sidebars, timelines, chart slots, image/copy slides,
  table-of-contents, client lists, quotes, big-copy, and closing slides.
- `/src/icons.tsx` and `/src/diagrams.tsx` — small branded SVG icons, flow
  diagrams, terminal/browser mockups, and diff blocks for richer generated
  slides without ReactFlow or browser-only dependencies.
- Host-served preview assets for the generated deck: Cloudflare logo SVGs and a
  curated set of Cloudflare icon SVGs under `/public/logos/*` and
  `/public/cf-icons/*`.
- `/src/styles.css` — Cloudflare warm cream/orange palette, inset slide frame,
  dotted texture, card grids, stat rows, and code block styling.

## Gaps This Example Surfaces

- `worker-bundler` now provides `createGeneratedApp()` and async
  `SourceProvider`s, while `@cloudflare/shell` provides
  `createWorkspaceSourceProvider(workspace)`. The remaining gap is richer
  incremental caching/build invalidation instead of rematerializing the provider
  for each preview build.
- The example now uses package-level debounced rebuild state after slide
  mutations. A future Think workspace bootstrap API could make the seed files
  and post-tool rebuild policy declarative for generated apps that use general
  workspace-edit tools.
- Generated React apps now have a clearer CSS/assets path: durable assets live
  under `/public/**`, while generated host-only files such as `index.html` and
  `styles.css` are virtual assets passed through the build helper.
- The CF 2026 port is high-fidelity in geometry, component vocabulary, prompt
  guidance, logos, and a curated icon subset. It still approximates some of the
  official template background PNGs and custom typography with CSS gradients and
  system fonts. A broader package-level asset catalog would let this reach
  closer visual parity.
- The Think version now has enough authoring surface to replace the core
  container editing loop, but it still lacks Let It Slide's browser-driven
  extraction/export pipeline for editable PPTX and Google Slides.
- The preview is rebuild-on-demand, not HMR. That is acceptable for the example,
  but a richer package primitive could refresh clients automatically after
  successful workspace-driven rebuilds.

## What Is Intentionally Out Of Scope

- Containers and shell command execution
- PPTX, PDF, Google Slides, or screenshot export
- Remote MCP auth
- The complete 50+ component CF 2026 library and 200-icon asset set. This
  example ports the replacement-shaped subset that can run cleanly inside the
  generated Worker preview.
