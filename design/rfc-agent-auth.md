# RFC: Agent Auth — a minimal authority plane

Status: proposed

## Problem

An Agent needs to answer three questions before it uses a tool:

1. **Credentials** — what secret or OAuth grant lets this Agent call the service?
2. **Permissions** — should this Agent allow, ask, or deny this particular operation?
3. **Identity** — which Agent is acting, and is it acting for an authenticated user?

The Agents SDK already has useful pieces: each Agent is a Durable Object with isolated
storage, MCP has a durable OAuth client provider, MCP tools expose risk annotations, and
the SDK has existing human-approval mechanisms. What is missing is one small Agent-native
abstraction that joins those pieces together.

This RFC proposes a native manager:

```ts
abstract class Agent<Env, State> {
  readonly auth: AgentAuthManager;
  readonly mcp: MCPClientManager;
}
```

`this.auth` owns credentials and policy for exactly one Agent instance. It is used
automatically by MCP and by locally authored authenticated tools.

## Goals

- Store OAuth grants and API keys durably, isolated to one Agent.
- Apply mutable `allow` / `ask` / `deny` policy to MCP and local tools.
- Make policy editable throughout the Agent's lifetime without repeating authentication.
- Give every decision a stable Agent identity and, when available, a verified user
  identity.
- Preserve standard MCP and OAuth behavior.
- Return ordinary AI SDK tools from the local-tool helper.
- Minimize refresh races and make failure states testable.
- Allow custom credential mechanisms, policy stores, and approval UIs through small
  interfaces.

## Non-goals

- A credential vault shared between Agents.
- A required central policy service.
- A new tool protocol competing with MCP.
- Passing credentials to models, codemode sandboxes, browsers, or tool arguments.
- Per-call token attenuation. RFC 8693 token exchange is complementary, but is not
  required to solve Agent-local control and is outside the core design.
- A complete externally verifiable Agent identity protocol. This RFC defines the local
  identity envelope and leaves external proof as a follow-up.

## Core model

### Credentials set the ceiling; policy controls current use

Authentication and permission are separate lifecycles.

```text
Agent-local grant
  maximum upstream authority obtained through OAuth or a supplied key
                         │
                         ▼
Agent-local policy
  allow, ask, or deny this tool call now
                         │
                         ▼
credential use
  attach the credential only after policy allows the call
```

A user may authorize broad OAuth scopes and later deny one tool without revoking the
connection or repeating OAuth.

### Grants belong to one Agent

A dynamically acquired grant is stored in the Durable Object that represents the Agent
which received it.

```text
User connects Agent A  → grant exists in Agent A
Agent B                → cannot discover or use the grant
```

There is no shared user grant store. If a parent and child Agent need to cooperate, the
parent performs the authenticated operation through typed RPC. Delegation of authority
between Agents is a separate design.

### Tools never select credentials

A tool describes what it needs. It does not look up a named token or connector. The auth
manager matches the requirement to a grant owned by the current Agent.

For remote MCP tools, the MCP server owns the tool definitions and OAuth discovery. The
Agent developer does not redeclare them.

### Capability source and model presentation are separate axes

MCP, local APIs, and libraries such as Workspace are capability sources: they define what
an operation means. Direct AI SDK tools and codemode are model-facing presentations: they
define how the model invokes that capability.

```text
MCP ─────────┬─ direct AI tool
             └─ codemode method

Workspace ───┬─ direct AI tool
             └─ codemode method
```

Authorization follows the underlying capability, not its presentation. The capability
adapter normalizes and authorizes the call once at its final effect boundary. Direct and
codemode presentations invoke that same boundary; presenting an MCP tool through codemode
must not add a second policy decision.

The presentation supplies execution context and handles the result. A direct presentation
surfaces a requestable denial to its caller. Codemode records the same denial as a durable
pause and, on resume, invokes the capability boundary again for fresh evaluation.

```ts
interface AuthorityOperation {
  callId: string;
  principal: AgentPrincipal;
  domain: string; // e.g. "tool", "workspace"
  action: string; // e.g. "delete_worker", "fs.writeFile"
  resource?: {
    type: string; // e.g. "mcp_server", "path", "git_remote"
    id: string;
  };
  parameters: unknown; // validated, normalized parameters
  capability?: {
    id: string;
    definitionDigest: string;
    annotations?: ToolAnnotations;
  };
  context?: Record<string, unknown>;
  execution: {
    mode: "direct" | "codemode";
    executionId?: string;
    sequence?: number;
  };
}
```

Tool adapters use MCP's standard annotation vocabulary (`readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint`). Other domains supply their own
stable action, resource, and normalized parameter vocabulary. Domain metadata informs
policy but is not trusted proof of behavior.

## Native Agent API

The SDK initializes `AgentAuthManager` after Agent storage is available, in the same style
as `MCPClientManager`.

Local tools hold typed auth descriptors directly:

```ts
const weatherAuth = apiKey({
  resource: "https://api.weather.example",
  in: "header",
  name: "X-API-Key",
  setup: { label: "Weather API key" }
});
```

A descriptor contains no user credential. It is immutable, reusable across tools, and
identified durably by a canonical digest of its non-secret configuration (scheme,
resource, presentation, and setup version). JavaScript object identity is never used as a
storage key.

`this.auth.configure()` is only needed for deployment credential machinery such as a
pre-registered OAuth client or machine credential. It is idempotent because `onStart()`
may run after hibernation.

Policy is configured and stored through `this.auth.policy`, not through credential
configuration. Persisted user rules override application policy. When neither supplies a
matching decision, authorization returns `ask` rather than guessing from annotations.

The manager exposes three small surfaces:

```ts
this.auth.grants; // provision, inspect, revoke
this.auth.policy; // allow, ask, deny, explain
this.auth.identity; // current Agent and optional user principal
```

## 1. Credentials

### Grant records

A grant records durable authority; secret material is stored separately and referenced
by ID.

```ts
interface AgentGrant {
  id: string;
  resource: string;
  scheme: string;
  scopes?: string[];
  secretRef: string;
  status: "active" | "uncertain" | "revoked";
  createdAt: number;
  expiresAt?: number;
}
```

Examples:

- An OAuth authorization-code flow stores refresh/access token material.
- An API-key connection stores the supplied key.
- An autonomous Agent may use a configured machine credential source.

The grant record and secret are inaccessible to the model and are never returned through
the client SDK.

### Storage

The default implementation uses the current Agent's Durable Object storage:

| Data                          | Default storage                                          |
| ----------------------------- | -------------------------------------------------------- |
| Grant metadata                | Agent SQLite                                             |
| OAuth tokens / API keys       | Agent-local secret store referenced by grant ID          |
| PKCE verifier and OAuth state | Agent storage with expiry and single-use semantics       |
| Short-lived access token      | Agent storage or memory with expiry                      |
| OAuth client secret           | Worker secret binding; never copied into the Agent grant |

The storage interface is replaceable for applications that require external key
management:

```ts
interface CredentialStore {
  getGrant(id: string): Promise<AgentGrant | undefined>;
  putGrant(grant: AgentGrant): Promise<void>;
  putSecret(value: SecretValue): Promise<string>;
  getSecret(ref: string): Promise<SecretValue>;
  deleteSecret(ref: string): Promise<void>;
}
```

Replacing the store does not change grant ownership: the key namespace must still be the
current Agent identity.

### Credential providers

OAuth and API keys use the same narrow extension interface:

```ts
interface CredentialProvider {
  supports(requirement: AuthRequirement): boolean;
  provision(request: ProvisionRequest): Promise<AgentGrant | AuthChallenge>;
  credential(
    grant: AgentGrant,
    request: CredentialRequest
  ): Promise<Credential>;
  invalidate(grant: AgentGrant, rejected: Credential): Promise<void>;
}
```

The SDK initially ships:

- MCP OAuth using the existing MCP `OAuthClientProvider` contract.
- OAuth authorization code with PKCE.
- API key / bearer token import.
- A machine credential provider for autonomous Agents.

Additional OAuth grants and Cloudflare-specific mechanisms can be providers without
changing tool or policy APIs.

A provider may be local or backed by a service binding. Tools do not change when an
organization moves credential issuance to a central broker: both receive the descriptor's
normalized requirement and stable ID, and both return the same grant/challenge types.

### OAuth standards

OAuth support follows standard discovery and binding:

- RFC 9728 Protected Resource Metadata for MCP resources.
- RFC 8414 Authorization Server Metadata.
- PKCE for authorization code flows.
- RFC 8707 resource indicators where supported.
- RFC 7591 dynamic client registration where supported.

A local tool declares a reusable resource requirement:

```ts
const issuesAuth = oauth2({
  resource: "https://api.issues.example"
});
```

The SDK obtains authorization servers from RFC 9728 Protected Resource Metadata, then
uses RFC 8414 Authorization Server Metadata. This is the required path for remote MCP;
MCP developers do not configure an authorization-server URL.

If the authorization server requires a pre-registered confidential client, deployment
code supplies it separately:

```ts
this.auth.configure({
  oauthClients: [
    oauthClient({
      clientId: this.env.ISSUES_CLIENT_ID,
      clientSecret: this.env.ISSUES_CLIENT_SECRET
    })
  ]
});
```

The SDK matches the client registration to discovered authorization-server metadata.
Where multiple clients could match, `oauthClient` may include an issuer constraint; this
is deployment configuration, not repeated tool metadata.

Generic HTTP APIs do not universally publish RFC 9728 metadata. Their descriptor may use
an optional compatibility override:

```ts
const legacyIssuesAuth = oauth2({
  resource: "https://api.issues.example",
  authorizationServer: "https://identity.issues.example"
});
```

`resource` is required once in the shared descriptor: it is the destination boundary for
`auth.fetch()` and, where supported, the RFC 8707 audience. Neither descriptors nor OAuth
client configuration create a grant. Each Agent stores the grant created by its own
completed authorization flow.

### Provisioning

A grant can be connected proactively or on first use:

```ts
await this.auth.grants.connect(toolOrMcpServer);
```

The result is either connected or a structured challenge:

```ts
type AuthChallenge =
  | { type: "oauth_redirect"; url: string; requestId: string }
  | { type: "device_code"; requestId: string; details: unknown }
  | { type: "secret_input"; requestId: string; fields: SecretField[] };
```

OAuth callbacks are routed to the exact Agent instance. API-key input is posted directly
to that Agent and never reflected back to the client.

### Refresh correctness

The Agent is the credential owner and serialization boundary. The manager uses one
in-memory single-flight operation per grant and persists successful token rotation before
returning the credential to callers.

It does not use:

- An independently updated KV token cache.
- A proactive refresh alarm.
- Blind retries of ambiguous refresh requests.

An external token endpoint cannot participate in an atomic transaction with Agent
storage. If a rotating refresh token may have been consumed but the successful response
was lost, the grant becomes `uncertain`. The SDK must require recovery or
reauthorization rather than retrying an ambiguous request.

## 2. Durable policy and authorization

Policy is mutable Agent state and does not modify the upstream grant.

```ts
await agent.auth.policy.deny({
  domain: "tool",
  actions: ["delete_worker"],
  selector: { mcpServer: "cloudflare" }
});
```

This takes effect on the next call while leaving the Cloudflare OAuth connection intact.

### One decision contract

All execution paths call:

```ts
this.auth.authorize(operation);
```

and receive:

```ts
type AuthorizationDecision =
  | { decision: "allow"; policyRevision: number }
  | {
      decision: "deny";
      policyRevision: number;
      reason: string;
      ruleId?: string;
      request?: {
        id: string;
        summary: string;
      };
    };
```

- `allow` permits credential resolution and dispatch.
- A denial without `request` is terminal under current policy.
- A denial with `request` is a requestable denial: execution remains blocked while a
  governance workflow decides whether current policy should permit the operation.

Policy rules retain `ask` as an ergonomic authoring decision. At runtime, `ask` produces
a denial with a durable request; it never permits execution by itself. The policy engine
does not execute operations and does not own codemode replay.

### Rules

```ts
interface PolicyRule {
  id: string;
  domain: string;
  actions?: string[];
  resources?: Array<{ type?: string; id?: string }>;
  selector?: unknown; // interpreted by the registered domain adapter
  decision: "allow" | "ask" | "deny";
  capabilityDigest?: string;
  expiresAt?: number;
}
```

Rules are stored in the Agent. Generic fields match domain, action, and exact resource.
The optional selector lets a domain add typed constraints such as an MCP server, auth
descriptor, workspace path prefix, backend, or Git remote without teaching the core
policy engine every resource ontology.

`capabilityDigest` prevents a persisted approval from silently applying after a discovered
tool or other capability definition changes.

### Durable authorization requests

A request is idempotent by `callId` and operation digest. Concurrent retries return the
same pending request instead of opening multiple approval prompts.

```ts
interface AuthorizationRequest {
  id: string;
  callId: string;
  operationDigest: string;
  policyRevision: number;
  status: "pending" | "approved" | "denied" | "expired";
  summary: string;
  createdAt: number;
  resolvedAt?: number;
}
```

The operation digest is SHA-256 over a canonical serialization of the normalized domain,
action, resource, parameters, principal, and capability definition. Domain adapters must
define normalization before hashing, including omitted defaults and set-like arrays.

Only bounded, redacted policy inputs and their digest are persisted. Credentials and
OAuth codes are never part of an authorization request.

The management API resolves requests atomically:

```ts
agent.auth.requests.listPending();
agent.auth.requests.resolve(requestId, "allow_once");
agent.auth.requests.resolve(requestId, "always_allow", selector);
agent.auth.requests.resolve(requestId, "deny");
```

`always_allow` writes a policy rule and resolves the request in the same storage
transaction. A duplicate or stale resolution is a no-op. Approval is an input to a fresh
policy evaluation, not a grant: the PEP recomputes the operation digest and calls
`authorize()` again immediately before execution.

### Policy sources and precedence

The SDK does not impose read-only/destructive policy defaults. MCP annotations are inputs
a policy may match, not decisions by themselves.

Local policy evaluation order is:

1. Persisted user policy for this Agent.
2. Optional application policy supplied by the developer.
3. `ask` when neither produces a decision.

This lets applications choose their own posture while ensuring user changes made over the
Agent's lifetime take precedence.

An organization may additionally install a mandatory policy provider:

```ts
interface MandatoryPolicyProvider {
  evaluate(operation: AuthorityOperation): Promise<"allow" | "ask" | "deny">;
}
```

The effective decision is the more restrictive of mandatory policy and local policy
(`allow < ask < deny`). Users can always tighten central policy but cannot weaken it. A
central provider is consulted at dispatch so policy changes can take effect without
reissuing Agent grants. Implementations may use bounded caching only when they explicitly
accept the resulting revocation delay. Invalid or unavailable mandatory policy fails
closed.

For example, an application may opt into an annotation-based policy:

```ts
this.auth.policy.setApplicationPolicy(({ capability }) => {
  if (capability?.annotations?.destructiveHint) return "ask";
  if (capability?.annotations?.readOnlyHint) return "allow";
  return "ask";
});
```

It is not part of credential configuration and is not an SDK default.

The RFC does not introduce a second safeguard field. AI SDK `needsApproval` remains a
compatibility input to the authorization adapter; otherwise durable Agent policy decides.

A broad code-execution tool cannot be safely classified by HTTP-method regexes on the
client. Finer policy requires the server or connector to expose a structured operation,
not client-side source-code heuristics.

### Enforcement

Authorization is checked at the last controllable boundary before an operation. Tool
adapters may also evaluate policy during listing to hide denied tools from model and
codemode discovery, but filtering is exposure control rather than authorization.

For an operation that pauses, authorization is checked:

1. With validated, normalized parameters before credential resolution or dispatch.
2. Again after approval, immediately before the effect.

The final check uses the latest policy revision and the same operation digest. A stale
approval cannot bypass a policy, parameter, principal, or capability-definition change
made while the call was waiting.

### Policy API

```ts
agent.auth.policy.allow(selector);
agent.auth.policy.ask(selector);
agent.auth.policy.deny(selector);
agent.auth.policy.list();
agent.auth.policy.remove(ruleId);
agent.auth.policy.evaluate(operation); // pure explanation; does not create a request
```

Policy and request administration are authenticated owner APIs. They are not model tools
by default.

The approval presentation is pluggable:

```ts
interface ApprovalHandler {
  present(request: AuthorizationRequest): Promise<void>;
}
```

Chat approval, MCP elicitation, workflow UI, or a custom client may present the same
durable request. Presentation does not decide policy and may be retried safely.

## 3. Identity

Identity is intentionally minimal in this RFC because the SDK has a reliable Agent
identity but does not currently have one universal source of authenticated user identity.

```ts
interface AgentPrincipal {
  agent: {
    id: string; // stable Durable Object identity
    class: string;
  };
  user?: {
    issuer: string;
    subject: string;
    claims?: Record<string, unknown>;
  };
}
```

### Agent identity

The manager derives Agent identity from the current Agent/Durable Object. It is stable for
the lifetime of that Agent and is used to:

- Namespace grants and policy.
- Attribute audit events.
- Prevent accidental cross-Agent storage lookup.

This is a local platform identity. It is not, by itself, cryptographic proof to an
external API that a particular Agent made a request.

### User identity

A user identity must come from a verified application authentication path, never from
model input or arbitrary request headers.

The SDK accepts a small resolver:

```ts
interface PrincipalResolver {
  resolve(
    context: AgentRequestContext
  ): Promise<AgentPrincipal["user"] | undefined>;
}
```

Applications can adapt Access JWT validation, their session system, or another IdP. MCP
server auth context can supply a verified subject for inbound MCP calls. If no user is
present, policy and grants operate for the Agent principal alone.

The unresolved follow-up is external Agent proof: workload identity, signed Agent
assertions, sender-constrained tokens, and actor chains. Those mechanisms should build on
this envelope without being required for local grant isolation and policy.

## Capability and presentation adapters

The authorization kernel is independent of both capability source and presentation.
Capability adapters own operation semantics; presentation adapters own model-facing
execution and pause/resume behavior.

### Capability adapter contract

A capability source must produce one bound effect:

```ts
interface AuthorityEffect<T> {
  operation: Omit<AuthorityOperation, "callId" | "principal" | "execution">;
  execute(): Promise<T>;
}
```

The effect closes over the exact validated parameters it will execute. The capability
adapter passes it through `Agent.auth` exactly once. Presentations do not reconstruct,
classify, or separately authorize it; they only invoke the adapter and handle an allowed,
requestable-denied, or terminal-denied outcome.

### Domain library hook

A domain library owns the operation vocabulary because it knows where effects occur and
which parameters matter. It exposes a small framework-neutral gate:

```ts
interface OperationGate<Operation> {
  run<T>(operation: Operation, effect: () => Promise<T>): Promise<T>;
}

interface AuthorityDomainAdapter<Operation> {
  domain: string;
  normalize(
    operation: Operation
  ): Omit<AuthorityOperation, "callId" | "principal" | "execution">;
  summarize(operation: Operation): string;
  matches?(selector: unknown, operation: Operation): boolean;
}
```

`AgentAuthManager.gate(adapter)` returns an `OperationGate` that the library accepts. The
domain package depends only on the structural hook, not on Agents:

```ts
const workspace = new Workspace({
  storage: this.ctx.storage,
  gate: this.auth.gate(workspaceAuthority())
});
```

The gate executes this sequence:

1. Normalize the domain operation.
2. Authorize it against current policy.
3. On a requestable denial, persist/present the request and do not call `effect`.
4. On allow, recompute the operation digest and invoke `effect` exactly once.
5. Record the decision and outcome without secret or raw-content leakage.

The callback shape keeps the check at the last controllable boundary and binds it to the
exact parameters closed over by `effect`. Authorization and observability remain separate:
the gate may prevent or pause work; an observer records telemetry and must not alter
execution.

A library must mediate every public path capable of the claimed effect if it claims
non-bypassable enforcement. For the common Agent integration, a shared Workspace adapter
can create identical `AuthorityEffect` values for direct and codemode tools without
changing Workspace internals. An optional low-level Workspace gate is only needed when
application/RPC callers outside those tool adapters must also be governed.

### Workspace mapping

Workspace is a capability domain, not a third presentation. Its operations can be exposed
to the model as direct AI tools, codemode methods, or both, while normalizing identically:

```ts
{ domain: "workspace", action: "fs.readFile",  resource: { type: "path", id: path } }
{ domain: "workspace", action: "fs.writeFile", resource: { type: "path", id: path } }
{ domain: "workspace", action: "shell.exec",   resource: { type: "backend", id: backend } }
{ domain: "workspace", action: "git.push",     resource: { type: "git_remote", id: remote } }
```

Workspace should gate logical public operations, not every internal filesystem call made
by a composite operation. For example, `git.commit` is one operation even though it reads
and writes many VFS paths. Internal raw facades use private capabilities; public `fs`,
`git`, `shell`, RPC stubs, assets, artifacts, and sync entry points must all pass through
the gate.

`shell.exec` is open-world: once a process starts, the host cannot pre-authorize each file
or network effect it produces. The host can authorize the command as one operation and
audit the resulting sync changes. Claims of path-level or egress enforcement require an
additional PEP in the backend/FUSE/egress layer; the host hook must not claim controls it
cannot enforce.

### MCP capability source

MCP is a capability source because the server defines tool identity, schemas,
annotations, auth, and execution. The same discovered tool can be presented directly or
through codemode. The developer does not rewrite it:

```ts
await this.addMcpServer("cloudflare", "https://mcp.example.com/mcp");

const tools = this.mcp.getAITools();
```

The MCP capability adapter:

1. Preserves standard MCP `ToolAnnotations`.
2. Computes `definitionDigest` from server identity, tool name, schema, annotations, and
   available authorization metadata.
3. Filters denied tools during listing.
4. Constructs one bound `AuthorityEffect` after MCP arguments validate.
5. Dispatches only after `this.auth.authorize()` returns `allow`.
6. Attaches the MCP credential after authorization, never before.

`this.mcp.getAITools()` presents those effects as AI SDK tools. `McpConnector` presents the
same MCP capabilities as codemode methods. Both route execution through the canonical,
authority-aware `MCPClientManager.callTool()` boundary. The codemode connector must not
call an ungated raw MCP client and must not run a second authorization decision.

Standard OAuth discovery and grant provisioning remain MCP-native. The existing
`DurableObjectOAuthClientProvider` is adapted behind `AgentAuthManager`, not replaced.

MCP server-side elicitation remains valid for decisions only the server can make. It does
not replace the Agent's local policy check.

### Local capability sources

For a direct HTTP API, the developer supplies the capability and auth requirement.
`authenticatedTool()` takes an AI SDK-shaped definition plus Agents metadata and returns a
normal AI SDK tool. Its only extension to the first argument is `name`, because AI SDK
normally takes the tool name from its containing object while durable policy needs a
stable name before execution. The helper removes `name` from the returned AI SDK tool:

```ts
const weatherAuth = apiKey({
  resource: "https://api.weather.example",
  in: "header",
  name: "X-API-Key",
  setup: { label: "Weather API key" }
});

const getForecast = authenticatedTool(
  {
    name: "weather.getForecast",
    description: "Get a weather forecast",
    inputSchema: z.object({ city: z.string() }),
    execute({ city }, { auth, abortSignal }) {
      return auth.fetch(`/forecast?city=${encodeURIComponent(city)}`, {
        signal: abortSignal
      });
    }
  },
  {
    auth: weatherAuth,
    annotations: { readOnlyHint: true }
  }
);
```

It is used directly:

```ts
streamText({ model, tools: { getForecast } });
```

The wrapper validates input, constructs an `AuthorityEffect`, and runs it through the
authorization kernel. The same authenticated tool can later be exposed through
`ToolSetConnector`; calling its wrapped `execute` reaches the same authorization boundary.
The connector handles a requestable denial as a codemode pause rather than layering a
second approval. Only after `allow` does the wrapper resolve the grant and invoke the
authored handler with:

```ts
interface ToolAuth {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}
```

`auth.fetch()` resolves relative URLs against the declared resource, rejects another
origin, prevents overriding credential headers, propagates cancellation, and redacts
secrets. The returned object satisfies AI SDK `Tool<Input, Output>`.

### Codemode presentation

Codemode is a model-facing presentation and durable execution mode, not a capability
source or another policy system. MCP, AI SDK ToolSets, OpenAPI, and Workspace can all
appear as codemode connectors. Each connector must preserve the underlying capability's
operation builder and annotations.

Existing `requiresApproval` and AI SDK `needsApproval` remain compatibility inputs that
produce `ask`; no new safeguard field is introduced.

For a fresh connector call, codemode invokes the authority-aware capability adapter with
its `executionId` and sequence:

- `allow` executes the effect and records its result.
- A requestable denial returns its request ID; codemode stores it on the log entry and
  pauses.
- A terminal denial ends the call without a side effect.
- Resume invokes the capability adapter again, causing current policy and the operation
  digest to be reevaluated before dispatch.

Codemode retains responsibility for deterministic replay, result logging, and preventing
further side effects after pause. The auth manager owns policy and approval state. This
separation avoids both duplicated policy and duplicated execution logs.

Credentials remain host-side and never enter generated code, connector descriptions, or
replay state.

## Testing

Each layer is independently testable.

### Tool tests

```ts
await testAuthority({
  grants: [fakeApiKeyGrant()],
  policy: "allow"
}).execute(getForecast, { city: "Amsterdam" });
```

Tests can assert the outgoing request without reading a real secret.

### Policy tests

Policy evaluation is a pure operation over principal, tool metadata, validated input,
rules, and current time. Test allow/ask/deny and precedence without network calls.

### Credential tests

Providers run against a fake token endpoint and deterministic store. Required cases:

- Concurrent callers share one refresh.
- Successful rotation is persisted before use.
- Terminal OAuth errors revoke or invalidate the grant.
- Ambiguous refresh results mark the grant uncertain and are not retried.
- OAuth state and PKCE verifier are single-use and expire.

### Integration tests

Create one `AuthorityOperation` fixture and run it through:

- A local `authenticatedTool()`.
- An MCP tool returned by `getAITools()`.
- A codemode connector invocation.

All three must produce the same decision, request fingerprint, policy revision, and audit
event. Additional required races:

- Concurrent identical calls create one pending request.
- Two clients resolving one request produce one state transition.
- Policy changing while a call is pending is observed before dispatch.
- Tool metadata changing invalidates a prior approval.
- Codemode cannot continue side effects after a paused or denied call.

## Audit events

The manager emits structured events without credential material:

```ts
interface AuthorityEvent {
  agentId: string;
  user?: { issuer: string; subject: string };
  domain: string;
  action: string;
  resource?: { type: string; id: string };
  operationDigest: string;
  decision: "allow" | "deny";
  policyRevision: number;
  ruleId?: string;
  requestId?: string;
  grantId?: string;
  outcome?: "succeeded" | "failed";
  timestamp: number;
}
```

An optional `AuditSink` receives these events. Logging must redact credentials and OAuth
codes by construction.

## Optional centralized control

Typed descriptors are not references to a central registry. They are portable statements
of need. Before use, the SDK canonicalizes a descriptor into:

```ts
interface NormalizedAuthRequirement {
  id: string; // digest of canonical, non-secret fields
  scheme: string;
  resource: string;
  presentation?: unknown;
}
```

The full requirement and ID are supplied to local or centralized providers. Central
systems can therefore match security semantics such as resource, scheme, Agent principal,
tool, and user—not a fragile developer-chosen label.

```ts
this.auth.configure({
  credentialProviders: [centralCredentials(this.env.AGENT_AUTH)],
  mandatoryPolicy: centralPolicy(this.env.AGENT_POLICY)
});
```

This configuration changes where grants and mandatory decisions come from; it does not
change MCP servers or local tool definitions. A central credential provider may return a
provisioning challenge, an Agent-bound grant reference, or a short-lived credential. It
must not make one Agent's grant discoverable by another.

Central policy and credentials are independent. A broad grant may remain valid while a
central or user policy immediately denies one operation.

## Standards posture and deferred ideas

The core SDK contracts are intentionally smaller than the surrounding standards work.
They provide adaptation points without making unfinished profiles mandatory.

- **AuthZEN Authorization API 1.0** is the natural wire adapter for a remote mandatory
  policy provider. `AuthorityOperation` maps to subject, resource, action, and context.
  The SDK does not expose AuthZEN JSON as its internal TypeScript API because local policy
  should not require a network protocol.
- **AuthZEN Access Request and Approval Profile** provides the right model for requestable
  denials: denial binding, idempotent request creation, an opaque task handle, and fresh
  reevaluation after governance completes. The Agent-local request store implements these
  semantics; a central provider may expose the profile directly.
- **MCP asynchronous approval for tool calls (SEP-2848)** is currently experimental. If it
  lands, the MCP adapter can map a remote requestable denial to MCP Tasks. The local
  authorization kernel must not depend on that SEP, and client policy remains a separate
  gate from server-owned approval.
- **RFC 8785 JSON Canonicalization Scheme** is a suitable basis for operation and
  capability digests once each domain has normalized defaults and set-like values.
  Canonical JSON cannot supply missing domain semantics by itself.
- **RFC 8693 token exchange, RAR (RFC 9396), DPoP, EMA/ID-JAG, actor profiles, and
  transaction tokens** may strengthen credential projection and cross-domain identity.
  They do not replace execution-time policy and are deferred from the minimal kernel.
- **Mission/task authority** may later supply a durable purpose and lifecycle reference in
  `AuthorityOperation.context`. This RFC does not define Mission shaping, authority-set
  compilation, expansion, or cross-domain propagation. Adding those concepts now would
  overload a design whose immediate job is consistent local enforcement.

The practical rule is: evaluate locally where domain meaning lives, carry authority only
when it must travel, and keep approval as input to a fresh decision rather than turning it
into ambient authority.

## Relationship to workers-oauth-provider

The packages have separate responsibilities:

- `workers-oauth-provider` is an authorization server and protected-resource wrapper.
- `agents/auth` is the Agent-side credential and policy runtime.

They should interoperate through OAuth and MCP standards but neither requires the other.
Token exchange, EMA, and richer server-enforced attenuation can be added later as
credential providers without changing this RFC's tool, grant, policy, or identity APIs.

## Packaging

```text
agents
  Agent.auth                         native AgentAuthManager

agents/auth
  authenticatedTool
  OAuth and API-key requirements/providers
  grant, policy, identity, approval, and testing interfaces
  MCP OAuthClientProvider adapter
```

A separate package or service binding is not needed for the first implementation. If a
third-party provider ecosystem emerges, the small provider contracts can later move into
a zero-dependency core package.

## Ownership and migration plan

The migration moves shared authority concerns, not protocol implementations.

| Concern                                                                     | Owner after migration                                       |
| --------------------------------------------------------------------------- | ----------------------------------------------------------- |
| MCP transport, discovery, tool schemas, OAuth challenges, callback routing  | `MCPClientManager` and MCP SDK                              |
| OAuth protocol mechanics and MCP `OAuthClientProvider` compatibility        | Existing MCP OAuth provider, backed by `Agent.auth` storage |
| Agent-local grants, imported API keys, policy rules, authorization requests | `AgentAuthManager`                                          |
| MCP operation normalization and final `tools/call` boundary                 | Authority-aware `MCPClientManager.callTool()`               |
| Local HTTP operation normalization and effect boundary                      | `authenticatedTool()`                                       |
| Workspace operation vocabulary                                              | Shared Workspace capability adapter                         |
| Direct model presentation                                                   | AI SDK tool wrappers                                        |
| Code Mode model presentation, replay, pause/resume, rollback                | Codemode connectors and `CodemodeRuntime`                   |
| Authorization decisions and approval request lifecycle                      | `AgentAuthManager`                                          |
| Authorization audit records                                                 | `AgentAuthManager` / configured audit sink                  |
| Tracing and performance telemetry                                           | Existing observability systems                              |

MCP is not reimplemented inside `agents/auth`. The existing OAuth client provider remains
the MCP SDK adapter, including state, PKCE, dynamic registration, token refresh,
credential invalidation, authorization redirects, and callback behavior. Its durable
storage methods delegate to `AgentAuthManager` so MCP OAuth grants use the same ownership,
redaction, and revocation model as local credentials. Existing storage keys can be read
through a compatibility adapter and migrated lazily after a successful read; no OAuth
reconnection is required solely for this migration.

### Phase 1: Introduce the kernel without behavior changes

- Add `Agent.auth`, the `AuthorityOperation` type, domain-adapter contracts, policy and
  request tables, and the audit sink.
- Add deterministic operation normalization/digests and pure policy tests.
- Keep MCP OAuth, AI SDK approval, and codemode approval behavior unchanged.
- Provide compatibility adapters for existing `needsApproval` and `requiresApproval`.

This phase creates no new prompts and moves no protocol state.

### Phase 2: Unify local AI SDK tools

- Ship `authenticatedTool()` and API-key/OAuth descriptors.
- Wrap local execution at the final `execute` boundary.
- Translate AI SDK `needsApproval` into application policy returning `ask`.
- Store Agent-local credentials, policy, requests, and audit records in `Agent.auth`.

Local tools become the first end-to-end user of the kernel without changing AI SDK's
returned `Tool` shape.

### Phase 3: Adapt MCP credentials, then MCP policy

First adapt storage only:

- Make `DurableObjectOAuthClientProvider.tokens()`, `saveTokens()`, and
  `invalidateCredentials()` delegate to Agent-local grant storage.
- Preserve MCP SDK interfaces, discovery, transports, redirects, callbacks, and errors.
- Keep existing MCP server records and connection lifecycle in `MCPClientManager`.

Then add authorization at two existing seams:

- `getAITools()` / `listTools()` use policy only for exposure filtering.
- `MCPClientManager.callTool()` constructs and authorizes the operation after argument
  validation and immediately before `client.callTool()`.

Direct `callTool()` and AI SDK wrappers therefore cannot bypass policy. Add an
`McpConnectionLike` adapter backed by `MCPClientManager.callTool()` so `McpConnector`
reaches this same boundary when MCP is presented through codemode. It must not hold an
ungated raw MCP SDK client.

Server-originated MCP elicitation remains separate: it handles decisions the remote server
owns, while Agent policy governs whether this Agent sends the call.

### Phase 4: Unify codemode authorization without moving replay

Codemode keeps its durable execution tables and semantics. Its current `decide()` mixes
replay lookup with a boolean approval decision, so migration is staged:

1. Replace the single `decide()` step with a planning step that returns `replay` or
   `execute_fresh` for the `(executionId, sequence)` entry.
2. For `replay`, return the recorded result without invoking the capability; no effect and
   no authorization decision occur.
3. For `execute_fresh`, invoke the authority-aware capability adapter (MCP, wrapped AI SDK
   tool, OpenAPI, or Workspace) with codemode execution context. The capability adapter
   constructs and authorizes the operation once at its effect boundary.
4. Store any `authorization_request_id`, `operation_digest`, and `policy_revision` returned
   by that boundary on the codemode log entry. Existing `requires_approval` remains
   temporarily for schema and API compatibility.
5. A requestable denial marks the execution paused. A terminal denial marks it rejected.
6. On resume, invoke the capability adapter again. It reevaluates current policy and the
   operation digest before dispatch; codemode does not perform another policy check.

There is no cross-facet atomic transaction. Recovery relies on idempotent request IDs and
reconciliation: an approved request with a still-pending codemode row is safe to resume;
an executing row retains codemode's existing crash/re-execution semantics. The migration
does not claim exactly-once effects.

After callers migrate, `requiresApproval` remains an authoring compatibility field but no
longer creates or owns approval state. Codemode pending-action APIs return the linked
Agent-auth request, and approval UIs resolve that request rather than mutating a separate
codemode policy.

### Phase 5: Move approval presenters onto durable requests

- Adapt chat approval, MCP-facing UI, workflow UI, and custom clients to present the same
  `AuthorizationRequest`.
- Remove in-memory/session approval caches and duplicate consent-policy stores once their
  callers have migrated.
- Preserve presentation-specific UX; only request identity, state, and resolution become
  shared.
- Always reevaluate after approval. Approval is not itself a grant or permit.

### Phase 6: Add domain libraries, starting with Workspace

First ship a shared Workspace capability adapter that owns normalization, summaries,
path/remote selectors, and composite operation boundaries. The same adapter emits:

- ordinary AI SDK tools for direct presentation; and
- codemode connector methods for Code Mode presentation.

Both presentations invoke the same Workspace effects and therefore produce one operation
identity, one policy decision, and one audit shape.

For applications that require non-bypassable control over Workspace calls made outside
model tools, Workspace may additionally accept a framework-neutral `OperationGate`. That
optional hardening must cover all claimed public effect paths:

- public `Workspace.fs` and RPC stubs;
- logical `workspace.git` operations rather than every internal VFS read/write;
- `shell.exec`, `get`/`kill` where applicable, explicit `push`/`pull`, assets sharing,
  artifacts mutations/token issuance, and mount mutations; and
- `provider()`, which must be gated or treated as a privileged internal capability.

Audit shell commands as open-world operations and record post-exec sync changes. Do not
claim per-file or egress enforcement inside a running container without a backend/FUSE or
egress PEP.

### Phase 7: Identity and centralized providers

- Add verified principal resolution and use it across every adapter.
- Add optional mandatory-policy and central credential providers.
- Keep the same normalized operation contract so moving policy to AuthZEN, Cedar, OPA, or
  another PDP does not change MCP, local tools, codemode, or Workspace.
- Add richer workload identity or actor-chain support later without changing local Agent
  grant ownership.

### Removal criteria

Legacy approval state can be removed only when:

- direct and codemode presentations of the same MCP, local, or Workspace capability reach
  the same operation identity and single authorization boundary;
- all approval UIs resolve `Agent.auth` requests;
- replayed codemode calls never create new authorization requests;
- policy changes made while paused are observed before dispatch;
- all claimed Workspace public effect paths are gated; and
- audit records contain no credential material or raw sensitive payloads.

This sequence solves credential durability and runtime policy first without moving MCP
protocol ownership, weakening codemode replay, or requiring the unresolved external Agent
identity and Mission designs.

## Alternatives considered

### String-keyed auth profiles

Rejected as the primary tool API. They add a registry, permit configuration drift, and
make tools less portable. Typed descriptors retain TypeScript linkage while still
normalizing to stable serializable IDs for storage and central control.

### Separate permission systems for MCP, AI SDK tools, and codemode

Rejected. Capability adapters submit one `AuthorityOperation` to one durable authorization
kernel. Direct and codemode are presentations over those capabilities; codemode retains
replay responsibility, not policy ownership.

### Mandatory centralized authority service

Rejected as a baseline requirement. Agent-local grants and policy must work standalone.
Organizations can install central credential and mandatory policy providers through the
same narrow contracts.

### Policy inferred entirely from MCP annotations

Rejected. Annotations are useful selectors but are server-provided hints. Applications
and users decide their own policy; no read/write defaults are imposed by the SDK.

## Decision

Pending discussion. This RFC proposes `Agent.auth`, Agent-local grants, durable mutable
policy, a minimal principal envelope, typed auth descriptors for local tools, automatic
MCP integration, and a single operation-authorization contract shared with codemode and
domain libraries.
