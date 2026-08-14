import { createCodexAppServer } from "ai-sdk-provider-codex-cli";

// Uses the ChatGPT subscription authenticated by `codex login`.
//
// The app-server transport, NOT codexExec: `codex exec` hands back its answer
// as one blob, so the AI SDK emits a single text-delta at the very end and
// nothing streams. The app server keeps a JSON-RPC connection open and
// forwards token deltas as they arrive.
//
// Keep the nested Codex harness read-only: tools and effects belong to the
// rebuild demo's ToolRuntime, not to the model provider. (Codex ignores tool
// definitions entirely, so tool-driven strategies need a different provider.)
// Codex ignores tool definitions, and the SDK warns about it on every single
// generate() — mid-stream, into the middle of the agent's reply. Say it once
// here instead.
globalThis.AI_SDK_LOG_WARNINGS = false;
process.stderr.write(
  "note: Codex ignores tool definitions — strategies that depend on tool " +
    "calls (tollbooth approvals, the oracle) stay quiet with this provider.\n"
);

const provider = createCodexAppServer();

export default provider("gpt-5.6-sol", {
  approvalPolicy: "never",
  sandboxPolicy: "read-only",
  mcpServers: {},
  logger: false
});

// The provider owns a child process; the runner awaits this on exit.
export const close = () => provider.close();
