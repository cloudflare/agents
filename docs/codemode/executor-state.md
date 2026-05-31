# Executor State

The executor state facet gives the model a persistent scratchpad — working memory that survives across sandbox executions within the same conversation.

The sandbox is stateless and ephemeral. Each `codemode({ code })` call spins up a fresh isolated Worker. But the executor state facet is a DurableObject child of the agent, with its own storage.

## Platform SDK

```ts
// Save a value
await codemode.set("prs", prs);

// Read it back in a later tool call
const prs = await codemode.get("prs");

// Delete
await codemode.delete("prs");

// List all keys
const keys = await codemode.list();
```

## Use cases

### Cache expensive API results

```ts
// First call — fetch and cache
codemode({
  code: `async () => {
    const prs = await github.list_pull_requests({ owner: "cloudflare", repo: "agents" });
    await codemode.set("prs", prs);
    return \`Fetched \${prs.length} PRs\`;
  }`
});

// Later call — read from cache
codemode({
  code: `async () => {
    const prs = await codemode.get("prs");
    return prs.filter(pr => pr.title.includes("codemode"));
  }`
});
```

### Build up data incrementally

```ts
// Call 1 — fetch metadata
codemode({
  code: `async () => {
    const meta = await repoApi.request({ operationId: "get_repository", params: { owner: "cloudflare", repo: "agents" } });
    await codemode.set("report", { meta });
    return "Got metadata";
  }`
});

// Call 2 — add releases
codemode({
  code: `async () => {
    const report = await codemode.get("report");
    const releases = await repoApi.request({ operationId: "list_releases", params: { owner: "cloudflare", repo: "agents" } });
    report.releases = releases;
    await codemode.set("report", report);
    return "Added releases";
  }`
});

// Call 3 — use the full report
codemode({
  code: `async () => {
    return await codemode.get("report");
  }`
});
```

### Resume interrupted work

```ts
// Call 1 — start processing, save progress
codemode({
  code: `async () => {
    const prs = await github.list_pull_requests({ owner: "cloudflare", repo: "agents" });
    const processed = prs.slice(0, 10).map(pr => ({ number: pr.number, title: pr.title }));
    await codemode.set("processed", processed);
    await codemode.set("remaining", prs.slice(10));
    return \`Processed 10 of \${prs.length}\`;
  }`
});

// Call 2 — continue from where we left off
codemode({
  code: `async () => {
    const remaining = await codemode.get("remaining");
    const processed = await codemode.get("processed");
    const batch = remaining.slice(0, 10).map(pr => ({ number: pr.number, title: pr.title }));
    await codemode.set("processed", [...processed, ...batch]);
    await codemode.set("remaining", remaining.slice(10));
    return \`Processed \${batch.length} more\`;
  }`
});
```

## Architecture

```
Agent DO
  ├─ facet: codemode:executor   ← executor state (set/get/list)
  ├─ facet: codemode:github     ← connector session (approvals, cached tools)
  └─ facet: codemode:repoApi    ← connector session
```

The executor state facet is separate from connector session facets. Connector sessions hold connector-specific state (pending approvals, MCP tool cache). The executor state holds cross-connector working memory.

## Implementation status

🔜 Not yet implemented. The facet and platform SDK methods (`codemode.set`, `codemode.get`, `codemode.delete`, `codemode.list`) will be added in a follow-up.
