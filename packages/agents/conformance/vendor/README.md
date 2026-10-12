# MCP SDK v2 conformance fixture

`everything-server-v2.ts` is the workerd adaptation of the MCP TypeScript SDK
v2 conformance fixture:

- repository: `https://github.com/modelcontextprotocol/typescript-sdk`
- package tag: `@modelcontextprotocol/server@2.3.1`
- commit: `fcef852f6cdafea07f36cf6fae69b37c8adf85be`
- source: `test/conformance/src/everythingServer.ts`
- source SHA-256: `2442aebdd2f97995ff60c80ee8688603323b7c33cb9ac07ba87f47771ac5d119`

The local fixture keeps the upstream registrations while removing the
Node/Express entrypoint, Node transports, session registry, and Node event
store. It exports one factory for the Agents workerd conformance worker and uses
Web Crypto for request-state integrity. The scope-challenge registrations are
kept, but the upstream entrypoint's middleware that stamps `AuthInfo` from fixed
bearer tokens is not, so those checks always pass here.

When updating the SDK pin, fetch the source at the recorded commit, verify its
SHA-256, inspect a no-index diff against this file, and port only registration
changes needed by the workerd fixture.
