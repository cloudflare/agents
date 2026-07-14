# Tools

The merged tool registry: the machinery that assembles tools from many sources
into one validated, hook-wrapped set the model can call. The *sources* (Workspace,
Fetch, Skills, Actions) are their own contexts; this context owns the registry
vocabulary. See the [context map](../../../CONTEXT-MAP.md).

## Language

**Tool**:
A callable definition with a description, input schema, an optional executor, and
metadata. The unit the model chooses among.
_Avoid_: function, AI SDK ToolSet entry

**ToolSet**:
A named collection of tools (`Record<string, Tool>`). The shape every tool source
produces.
_Avoid_: tool map, tool list

**Server tool**:
A tool that runs server-side (it has an executor).

**Client tool**:
A tool with *no* executor: the call is emitted to the client, which runs it and
returns the result, suspending the turn. A colliding client tool never overrides a
server tool.
_Avoid_: browser tool, remote tool, client-declared tool (that names the *source*)

**Tool source**:
One origin of tools feeding the registry: builtin, external, actions, user, or
client.
_Avoid_: tool provider

**Merge precedence**:
The rule that later sources win on a name collision (builtin < external < actions
< user < client), with the exception that a client tool never overrides a server
tool.
_Avoid_: override order

**Capability block**:
A short deterministic prompt fragment grouping the available tools by their
`metadata.capability` family (workspace, skills, execution, external, delegation,
client), appended to the system prompt.
_Avoid_: capability prompt, tool families description

**ToolCallDecision**:
A hook result controlling one call: `allow` (optionally substituting input),
`block` (skip execution; model sees a blocked marker), or `substitute` (skip
execution; model sees supplied output).
_Avoid_: hook verdict

**Tool hooks**:
The `beforeToolCall` / `afterToolCall` pair wrapped around every tool's execution.
_Avoid_: middleware

**activeTools**:
A name list narrowing which tools are exposed for a given turn or step.
_Avoid_: enabled tools

**AssembledTools**:
The finished registry output: wrapped tools, descriptors, the executor, the
client/approval predicates, and the capability block.
_Avoid_: compiled tools

**ToolInputValidationError**:
The error *value* returned (not thrown) when a tool's input fails schema
validation, so the turn continues.
