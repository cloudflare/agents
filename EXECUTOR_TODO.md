# Executor-style codemode provider refactor TODO

## Design principles

- [x] Keep current PR branch point preserved; do this on a new branch.
- [x] No backward compatibility constraints for the new provider/proxy API.
- [x] Runtime is an implementation detail hidden from ordinary SDK users.
- [x] Public API keeps a swappable `executor` because users may bring their own sandbox executor.
- [x] Our long-term runtime bet is a stateful serverless facet, so internals should have a runtime seam.
- [x] Providers should be strict/class-based, matching Gatekeepers/Agents style.
- [x] Constructors are for dependencies; provider identity/behavior should be overridable methods.
- [x] Example specialization should feel like `class GithubProvider extends OpenApiSpecProvider { ... }`.
- [x] Provider SDKs are globals namespaced by provider: `<provider>.<method>()`.
- [x] Codemode platform SDK is the `codemode` namespace: `codemode.search()`, `codemode.describe()`, etc.
- [x] Model-facing proxy tool should not expose search/describe options; those live in the in-sandbox SDK.
- [x] Discovery/docs should be type-first for LLMs, not raw JSON schema.
- [x] Search should use Executor-style normalized/ranked matching.
- [x] Keep `createCodeTool(...)` behavior intact as the legacy/simple `{ code }` tool.

## Research: Executor repo feature inventory

- [x] Read core CodeExecutor/SandboxToolInvoker/runtime model.
- [x] Read ExecutionEngine and pause/resume/elicitation flow.
- [x] Read built-in discovery tools: search, sources.list, describe.tool.
- [x] Read search scoring/matching implementation.
- [x] Read dynamic worker tools proxy/dispatcher and binary handling.
- [x] Read plugin/source/tool schema registration model.
- [x] Read policy/approval/error result contract.
- [x] Decide which features are in scope for this branch vs future facet work.

## Research: Gadgets/Gatekeeper feature inventory

- [x] Re-read GatekeeperVendor/User/Gatekeeper interfaces.
- [x] Map Gatekeeper describe/getTypeScriptTypes/startSession to CodemodeProvider.
- [x] Map Gatekeeper facet/session state to hidden CodemodeRuntime seam.
- [x] Capture class/template-method provider conventions.

## API design

- [x] Define final model-facing tool input: `{ code: string }`.
- [x] Define in-sandbox platform SDK: `codemode.search`, `codemode.describe`, `codemode.providers`.
- [x] Define class base `CodemodeProvider` with cached docs and `startSession(runtime)`.
- [x] Define `OpenApiSpecProvider` template methods: `name()`, `spec()`, `request()`, `instructions()`, `snippets()`.
- [x] Define `McpProvider` with abstract `connect()`, overridable `toolName()`, `callTool()`, `disposeConnection()`.
- [x] Define `ToolsetProvider` class shape.
- [x] Define `ProviderSession` with optional `dispose()` and hidden runtime types.
- [x] Class-only API — no factory functions.

## Implementation

- [x] Add internal runtime abstraction (`runtime.ts`).
- [x] Replace outer proxy `{ search, describe, execute }` with `{ code }`.
- [x] Inject `codemode` platform namespace as a runtime provider/session.
- [x] Move search/describe implementation into platform namespace methods.
- [x] Refactor providers to class-based definitions (`CodemodeProvider`, `McpProvider`, `OpenApiSpecProvider`, `ToolsetProvider`).
- [x] Remove executor from provider construction/options.
- [x] Split snippets into descriptor registration (`addSnippetDescriptors`) and runtime session tools (`addSnippetTools`).
- [x] Add Executor-style normalized/ranked search (`search.ts`).
- [x] Ensure provider names reserve `codemode`.
- [x] Update exports.
- [x] Update `mcp-provider.ts` compatibility surface.
- [x] Update examples/codemode-providers.
- [ ] Update docs/readme.

## Lifecycle

- [x] Provider definitions are long-lived and do not own runtime-opened resources.
- [x] `ProviderSession` supports `dispose?()`.
- [x] `createProxyTool` opens provider sessions for each execution.
- [x] `createProxyTool` disposes sessions in `finally`.
- [x] MCP provider has overrideable `connect()` / `disposeConnection()` lifecycle hooks.
- [x] Browser-like providers can implement resource-owning sessions.
- [x] Platform `codemode` session is no-op/no disposal.

## Tests/validation

- [ ] Unit test class provider docs/session lifecycle.
- [ ] Unit test `codemode.search` structured results, cap/truncation, and normalized matching.
- [ ] Unit test `codemode.describe` provider and method docs.
- [ ] Unit test snippets execute through hidden runtime and can call provider SDK methods.
- [ ] Unit test proxy execute with provider namespace and codemode namespace.
- [ ] Unit test reserved provider name `codemode`.
- [x] Validate `npm run check`.
- [x] Validate example dry-run deploy.
