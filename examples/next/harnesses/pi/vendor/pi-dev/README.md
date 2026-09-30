# Pi development build inputs

These archives pin an unreleased `@earendil-works/pi-durable` for this
early-access example. pi 0.99.1 on npm stops at pi-durable's Package 16 (the
first tool turn); the inbox, agent events, abort and ownership, subagents,
and child tasks (Packages 17–19) are only on pi's `main`.

- Upstream: <https://github.com/earendil-works/pi>
- Commit: `2bbfcca437c3aa5a21af1e4ee44ae7a051f953ad`
- Package version: `0.99.1` (the version on `main`; the code is newer than
  the npm release of the same number)
- License: MIT, see [`../../licenses/mit-earendil-pi.txt`](../../licenses/mit-earendil-pi.txt)

The example installs the archives under their real package names:

- `@earendil-works/chord`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-durable`
- `@earendil-works/pi-telemetry`

The manifests drop sibling `@earendil-works/*` dependencies (the example
installs each archive itself, and `vite.config.ts` and `tsconfig.json`
dedupe them) and third-party dependencies the Worker never imports: pi-ai
keeps `openai` (the `openai-completions` API Workers AI uses), `partial-json`,
and `typebox`; chord drops `esbuild`, which only its Node bundler uses.
`SHA256SUMS` pins the checked-in bytes.

To rebuild from a pi checkout:

```sh
git clone https://github.com/earendil-works/pi && cd pi
npm ci --ignore-scripts
(cd packages/chord && npm run build)
(cd packages/telemetry && npm run build)
(cd packages/ai && npm run hydrate-model-data && npm run build:offline)
(cd packages/durable && npm run build)
cd - && node vendor/pi-dev/pack.mjs /path/to/pi
```

Replace the archives with normal npm versions once a pi release contains
pi-durable's Packages 17–19.
