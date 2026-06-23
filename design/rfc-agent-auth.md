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

### Every execution path submits the same authorization request

MCP, local AI SDK tools, and codemode must not implement separate permission systems.
Before a side effect crosses its host boundary, each adapter constructs the same
`ToolInvocation` and asks `this.auth.authorize()` for a decision.

```ts
interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

interface ToolInvocation {
  callId: string;
  principal: AgentPrincipal;
  source: { type: "mcp"; server: string } | { type: "local"; authId: string };
  tool: {
    name: string;
    definitionDigest: string;
    annotations?: ToolAnnotations;
  };
  input: unknown; // validated arguments
  execution: {
    mode: "direct" | "codemode";
    executionId?: string;
    sequence?: number;
  };
}
```

`ToolAnnotations` uses MCP's standard annotation vocabulary (`readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint`) for both MCP and local tools.
Annotations are policy hints, not trusted proof of behavior.

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
  source: { type: "mcp", server: "cloudflare" },
  tools: ["delete_worker"]
});
```

This takes effect on the next call while leaving the Cloudflare OAuth connection intact.

### One decision contract

All execution paths call:

```ts
this.auth.authorize(invocation);
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
    }
  | {
      decision: "ask";
      policyRevision: number;
      requestId: string;
      summary: string;
    };
```

- `allow` permits credential resolution and dispatch.
- `ask` durably records one pending authorization request and pauses the host execution.
- `deny` fails without resolving or using a credential.

The policy engine does not execute tools and does not own codemode replay. It only
produces and persists authorization decisions.

### Rules

```ts
interface PolicyRule {
  id: string;
  source: { type: "mcp"; server: string } | { type: "local"; authId: string };
  tools?: string[];
  annotations?: {
    readOnly?: boolean;
    destructive?: boolean;
    openWorld?: boolean;
  };
  constraints?: Record<string, unknown>;
  decision: "allow" | "ask" | "deny";
  definitionDigest?: string;
  expiresAt?: number;
}
```

Rules are stored in the Agent. They may target an exact tool, an MCP server or a local
auth descriptor's derived ID, a risk annotation, or validated input constraints such as
an account ID. Server-side developer APIs accept the descriptor and derive this ID; client
APIs receive the opaque ID from tool/grant metadata rather than constructing it.

`definitionDigest` prevents a persisted approval from silently applying after a tool's
schema, annotations, or auth requirement changes.

### Durable authorization requests

A request is idempotent by `callId` and invocation digest. Concurrent retries return the
same pending request instead of opening multiple approval prompts.

```ts
interface AuthorizationRequest {
  id: string;
  callId: string;
  invocationDigest: string;
  policyRevision: number;
  status: "pending" | "approved" | "denied" | "expired";
  summary: string;
  createdAt: number;
  resolvedAt?: number;
}
```

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
transaction. A duplicate or stale resolution is a no-op.

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
  evaluate(invocation: ToolInvocation): Promise<"allow" | "ask" | "deny">;
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
this.auth.policy.setApplicationPolicy(({ tool }) => {
  if (tool.annotations?.destructiveHint) return "ask";
  if (tool.annotations?.readOnlyHint) return "allow";
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

Authorization is checked:

1. When tools are listed, to hide denied tools from model and codemode discovery.
2. When validated input is available, before credential resolution.
3. After approval, immediately before transport or `fetch` dispatch.

The final check uses the latest policy revision and the same invocation digest. A stale
approval cannot bypass a policy or tool-definition change made while the call was
waiting.

### Policy API

```ts
agent.auth.policy.allow(selector);
agent.auth.policy.ask(selector);
agent.auth.policy.deny(selector);
agent.auth.policy.list();
agent.auth.policy.remove(ruleId);
agent.auth.policy.evaluate(invocation); // pure explanation; does not create a request
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

## Integration adapters

The authorization kernel is independent of how a tool was discovered or executed. MCP,
AI SDK, and codemode are adapters into the same `ToolInvocation` and decision contract.

### Remote MCP tools

MCP is the simplest integration because the server already defines its tools and auth.
The developer does not rewrite them:

```ts
await this.addMcpServer("cloudflare", "https://mcp.example.com/mcp");

const tools = this.mcp.getAITools();
```

The MCP adapter:

1. Preserves standard MCP `ToolAnnotations`.
2. Computes `definitionDigest` from server identity, tool name, schema, annotations, and
   available authorization metadata.
3. Filters denied tools during listing.
4. Constructs a `ToolInvocation` after MCP arguments validate.
5. Dispatches only after `this.auth.authorize()` returns `allow`.
6. Attaches the MCP credential after authorization, never before.

Standard OAuth discovery and grant provisioning remain MCP-native. The existing
`DurableObjectOAuthClientProvider` is adapted behind `AgentAuthManager`, not replaced.

MCP server-side elicitation remains valid for decisions only the server can make. It does
not replace the Agent's local policy check.

### Local AI SDK tools

For a direct HTTP API, the developer supplies the tool and auth requirement.
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

The wrapper validates input, constructs `ToolInvocation`, and calls the same authorization
kernel. Only after `allow` does it resolve the grant and invoke the authored handler with:

```ts
interface ToolAuth {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}
```

`auth.fetch()` resolves relative URLs against the declared resource, rejects another
origin, prevents overriding credential headers, propagates cancellation, and redacts
secrets. The returned object satisfies AI SDK `Tool<Input, Output>`.

### Codemode

Codemode is an execution mode, not another policy system. Every connector method is
normalized to the same MCP `ToolAnnotations`. Existing `requiresApproval` and AI SDK
`needsApproval` remain compatibility inputs that produce `ask`; no new safeguard field is
introduced.

Before a connector call, the host constructs a `ToolInvocation` with the codemode
`executionId` and sequence and calls `this.auth.authorize()`:

- `allow` lets the durable runtime mark the action executing and dispatch it.
- `ask` stores the authorization `requestId` on the pending log entry and pauses.
- `deny` terminates the call without dispatch.
- Resume rechecks the latest policy and invocation digest before dispatch.

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

Create one `ToolInvocation` fixture and run it through:

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
  source: { type: "mcp" | "local"; id: string };
  tool: string;
  decision: "allow" | "ask" | "deny";
  ruleId?: string;
  grantId?: string;
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

## Implementation sequence

1. Add `Agent.auth` with Agent-local grant, policy, and authorization-request tables.
2. Implement the canonical `ToolInvocation` and durable `authorize()` contract.
3. Adapt MCP OAuth storage and enforce authorization in MCP listing and dispatch.
4. Route codemode decisions through `authorize()` while retaining its replay log.
5. Add `authenticatedTool()` and API-key provisioning for local tools.
6. Add principal resolution, policy management APIs, and structured audit events.

This sequence solves credential durability and MCP policy first, without requiring the
unresolved external Agent identity design.

## Alternatives considered

### String-keyed auth profiles

Rejected as the primary tool API. They add a registry, permit configuration drift, and
make tools less portable. Typed descriptors retain TypeScript linkage while still
normalizing to stable serializable IDs for storage and central control.

### Separate permission systems for MCP, AI SDK tools, and codemode

Rejected. All three submit one `ToolInvocation` to one durable authorization kernel.
Codemode retains replay responsibility, not policy ownership.

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
MCP integration, and a single authorization contract shared with codemode.
