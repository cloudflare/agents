# pi development build inputs

These package tarballs are build-only inputs for `agents/harness`. The public
`agents` package bundles the required runtime code, so consumers do not install
these archives.

- Upstream: <https://github.com/earendil-works/pi>
- Commit: `c4b0e35abe631bc830190fa6cafbe81b098b97d7`
- License: MIT, see [`../../../../licenses/mit-earendil-pi.txt`](../../../../licenses/mit-earendil-pi.txt)
- Packages: `@earendil-works/chord`, `@earendil-works/pi-agent-core`,
  `@earendil-works/pi-ai`, `@earendil-works/pi-telemetry`, and
  `@earendil-works/pi-session-backend-sqlite-node`

The archives contain upstream's compiled `dist` files. Their manifests remove
runtime dependencies because they are aliases used only while building the
self-contained `dist/harness/index.js`; `typebox`, `yaml`, `ignore`, and `diff`
remain normal `agents` dependencies where the bundled graph needs them.
`SHA256SUMS` pins the exact checked-in artifacts. The build also substitutes an
ESM adaptation of `partial-json@0.1.7` because its CommonJS entry is not valid in
a secondary Cloudflare Worker module; its MIT license ships with the package.
