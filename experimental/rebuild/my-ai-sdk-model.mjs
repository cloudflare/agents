import { codexExec } from "ai-sdk-provider-codex-cli";

// Uses the ChatGPT subscription authenticated by `codex login`.
// Keep the nested Codex harness read-only: tools and effects belong to the
// rebuild demo's ToolRuntime, not to the model provider.
export default codexExec("gpt-5.6-sol", {
  approvalMode: "never",
  sandboxMode: "read-only",
  skipGitRepoCheck: true,
  webSearch: false,
  configOverrides: { mcp_servers: {} },
  logger: false
});
