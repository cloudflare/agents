# Pi development build inputs

These archives pin the unreleased pi `AgentHarness` API used by this early-access example.

- Upstream: <https://github.com/earendil-works/pi>
- Commit: `c4b0e35abe631bc830190fa6cafbe81b098b97d7`
- Package version: `0.84.4`
- License: MIT, see [`../../licenses/mit-earendil-pi.txt`](../../licenses/mit-earendil-pi.txt)

The example installs the archives under their real package names:

- `@earendil-works/chord`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-session-backend-sqlite-node`
- `@earendil-works/pi-telemetry`

The manifests keep only the runtime dependencies the built artifacts need. `SHA256SUMS` pins the checked-in bytes. Replace the archives with normal npm versions once a pi release contains the same durable harness API.
