# MCP SDK v2 conformance fixture

`everything-server-v2.ts` is the workerd adaptation of:

- repository: `https://github.com/modelcontextprotocol/typescript-sdk`
- tag: `@modelcontextprotocol/server@2.0.0-beta.4`
- commit: `e81758caed29f6568ce8873f7f9a3bd65b017d9c`
- source: `test/conformance/src/everythingServer.ts`
- source SHA-256: `3a94417774fa20b17971e8162f9865b1cefd2650c7d88fdcd17f971d91213852`

The local fixture keeps the upstream server registrations while removing the Node/Express entrypoint, Node transports, session registry, and Node event store. It exports one factory for the Agents workerd conformance worker and uses Web Crypto for request-state integrity.

Run the provenance checker before updating the SDK pin:

```sh
node conformance/vendor/check-upstream.mjs
```

To update, change the constants in `check-upstream.mjs`, verify the new source hash, inspect the generated no-index diff, and port only registration changes relevant to the workerd fixture.
