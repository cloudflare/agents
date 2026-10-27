# MCP SDK v2 conformance fixture

`everything-server-v2.ts` is the workerd adaptation of the MCP TypeScript SDK
v2 conformance fixture:

- repository: `https://github.com/modelcontextprotocol/typescript-sdk`
- package tag: `@modelcontextprotocol/server@2.4.0`
- commit: `951fe5603a7ec0b2dcb6a0b95d92cd86f93ad9e5`
- source: `test/conformance/src/everythingServer.ts`
- source SHA-256: `1ec5c8e22fc4a9daf37d6b34ee692c6ec4d097f314fcde4d7f26d241fdbbc408`

The local fixture keeps the upstream registrations while removing the
Node/Express entrypoint, Node transports, session registry, and Node event
store. It exports one factory for the Agents workerd conformance worker and uses
Web Crypto for request-state integrity. The scope-challenge registrations are
kept, but the upstream entrypoint's middleware that stamps `AuthInfo` from fixed
bearer tokens is not, so those checks always pass here. The SEP-2640 skills
catalog (`conformanceSkills.attach`, added in 2.4.0) is also left out: skills
are an extension, and the core lanes never select extension scenarios.

When updating the SDK pin, fetch the source at the recorded commit, verify its
SHA-256, inspect a no-index diff against this file, and port only registration
changes needed by the workerd fixture.
