# MCP SDK v2 conformance fixture

`everything-server-v2.ts` is the workerd adaptation of the MCP TypeScript SDK
v2 conformance fixture:

- repository: `https://github.com/modelcontextprotocol/typescript-sdk`
- package tag: `@modelcontextprotocol/server@2.0.0`
- commit: `cc4b41617ce3601b1290d67216ea0b194a3cd9ac`
- source: `test/conformance/src/everythingServer.ts`
- source SHA-256: `3a94417774fa20b17971e8162f9865b1cefd2650c7d88fdcd17f971d91213852`

The local fixture keeps the upstream registrations while removing the
Node/Express entrypoint, Node transports, session registry, and Node event
store. It exports one factory for the Agents workerd conformance worker and uses
Web Crypto for request-state integrity.

When updating the SDK pin, fetch the source at the recorded commit, verify its
SHA-256, inspect a no-index diff against this file, and port only registration
changes needed by the workerd fixture.
