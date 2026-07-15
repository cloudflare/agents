# MCP conformance failures and release impact

This file separates current conformance failures by ownership and explains the
impact of **not** changing library code in this PR.

The conformance-harness correction changes no file under
`packages/agents/src/`. It therefore does not change published package behavior
or require a new package preview by itself. Any product fix listed below must be
made in a separate library-code commit and followed by a fresh preview/release.

## Library behavior that would require a new release to change

| Area                                 | Scenarios                                                      | Current user impact if unchanged                                                                                                                                                                                      |
| ------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CIMD                                 | `auth/basic-cimd`                                              | Built-in OAuth uses Dynamic Client Registration. A server requiring a URL-based Client ID Metadata Document needs a custom OAuth provider. This is a SHOULD warning.                                                  |
| Scope retry limit                    | `auth/scope-retry-limit`                                       | The default step-up budget produces four authorization attempts; alpha.9 recommends three or fewer. A permanently unsatisfiable scope challenge can send the user through one extra OAuth round-trip before stopping. |
| Modern default `resultType` handling | `sep-2322-client-request-state`                                | Alpha.9 requires absent `resultType` to default to complete. Beta.4 rejects that final response after MRTR completes, so conformant servers relying on the default fail the call.                                     |
| Client credentials extension         | `auth/client-credentials-jwt`, `auth/client-credentials-basic` | Service-to-service servers requiring the optional `client_credentials` extension need a custom OAuth provider.                                                                                                        |
| Enterprise-managed authorization     | `auth/enterprise-managed-authorization`                        | RFC 8693 token exchange + RFC 7523 JWT bearer flows need a custom provider.                                                                                                                                           |
| Modern server tasks extension        | nine `tasks-*` failures                                        | `createMcpHandler` does not expose SEP-2663 durable tasks. Tools remain synchronous or use MRTR; task create/get/update/cancel is unavailable.                                                                        |
| SDK v1 Host/Origin validation        | `dns-rebinding-protection` in both legacy lanes                | `createLegacyMcpHandler` and `McpAgent` preserve their existing deployment-boundary policy. Local SDK v1 deployments must validate Host/Origin at the edge, in application middleware, or through transport options.  |
| Stateless 2025 reverse requests      | sampling/elicitation scenarios                                 | Sessionless compatibility cannot deliver server-to-client requests. Those users must use `createLegacyMcpHandler`/`McpAgent` or modern MRTR.                                                                          |
| Stateless 2025 SSE recovery          | `server-sse-polling`, `server-sse-multiple-streams`            | Session-addressed reconnect/replay requires a sessionful legacy endpoint.                                                                                                                                             |
| SDK v1 JSON Schema conversion        | `json-schema-2020-12` in both legacy lanes                     | SDK v1 registration emits draft-07 and strips some 2020-12 keywords.                                                                                                                                                  |
| SDK v1 SSE recovery                  | `server-sse-polling` in both legacy lanes                      | `McpAgent` lacks priming/retry hints; `WorkerTransport` also fails alpha.9's in-flight response resume check after Last-Event-ID reconnection.                                                                        |

## Alpha.9 referee/fixture incompatibilities

These remain visible as expected failures, but changing Agents library code to
make the malformed fixture pass is not recommended:

- `http-standard-headers`: the fixture advertises `resources` but returns an
  invalid result without `resourceTemplates` for `resources/templates/list`.
  The Agents manager eagerly discovers all advertised catalogs and correctly
  rejects the invalid response.
- `json-schema-ref-no-deref`: the fixture answers modern discovery itself, then
  delegates `tools/list` to SDK v1, which rejects protocol version
  `2026-07-28`; the intended network-`$ref` assertion never runs.
- `tasks-status-notifications`: alpha.9 emits only `SKIPPED` while its referee
  awaits a `subscriptions/listen` rewrite. The truthful runner reports this as
  **not exercised**, never as a pass.

## Clean compatibility evidence

The SDK v2 client is clean against all selected 2025-06-18 and 2025-03-26
scenarios. Against 2025-11-25, the only non-clean results are the CIMD and
scope-retry SHOULD-level behaviors described above.
