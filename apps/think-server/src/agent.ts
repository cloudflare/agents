/**
 * ThinkServer — Remote coding agent.
 *
 * Extends Think with model provider config (from CLI), workspace tools,
 * and code execution. All interaction is WebSocket native.
 *
 * The CLI sends config via callable `configure()` on connect.
 * The server saves it in Think's SQLite config and uses it for model calls.
 */

import { Think } from "@cloudflare/think";
import { callable } from "agents";
import type { Connection } from "agents";
import { createWorkspaceTools } from "@cloudflare/think/tools/workspace";
import { Workspace, createWorkspaceStateBackend } from "@cloudflare/shell";
import { gitTools } from "@cloudflare/shell/git";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/ai";
import { stateToolsFromBackend } from "@cloudflare/shell/workers";
import { Context, AgentContextProvider } from "agents/experimental/memory/context";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import { convertToModelMessages, pruneMessages } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createWorkersAI } from "workers-ai-provider";
import { getBlockDefinitions } from "./system-prompt";
import type { SecretBinding } from "./gated-fetch";

/** Config sent by CLI, persisted in Think's SQLite. */
interface ModelConfig {
  provider: "anthropic" | "openai" | "workers-ai";
  model: string;
  apiKey?: string;
  /** Gateway base URL (e.g. https://opencode.cloudflare.dev) */
  baseUrl?: string;
  /** Extra headers for gateway auth */
  headers?: Record<string, string>;
  /** GitHub PAT for git operations (clone, push, etc.) */
  githubToken?: string;
}

export class ThinkServer extends Think<Env, ModelConfig> {
  workspace!: Workspace;
  context!: Context;

  onStart() {
    super.onStart();
    this.workspace = new Workspace(this, { r2: this.env.R2 });
    const config = this.getConfig();
    this.context = new Context(new AgentContextProvider(this), {
      blocks: getBlockDefinitions({ hasGithubToken: !!config?.githubToken })
    });
  }

  /**
   * Handle config messages from CLI.
   * Unrecognized messages fall through from Think's protocol handler.
   */
  async onMessage(connection: Connection, message: string | ArrayBuffer) {
    if (typeof message === "string") {
      try {
        const data = JSON.parse(message);
        if (data.type === "cf_think_config" && data.config) {
          const cfg = data.config as ModelConfig;
          this.configure(cfg);
          connection.send(JSON.stringify({
            type: "cf_think_config_ack",
            config: data.config
          }));
          return;
        }
        if (data.type === "cf_think_get_messages") {
          connection.send(JSON.stringify({
            type: "cf_agent_chat_messages",
            messages: this.messages
          }));
          return;
        }
      } catch {}
    }
  }

  // ── Think overrides ────────────────────────────────────────────

  getModel(): LanguageModel {
    const config = this.getConfig();

    if (config?.provider === "anthropic") {
      const apiKey = config.apiKey ?? this.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("No Anthropic API key configured");

      // Detect gateway token (JWT) vs direct API key
      const isGatewayToken = apiKey.includes(".") && !apiKey.startsWith("sk-ant-");

      if (isGatewayToken) {
        // Route through OpenCode Cloudflare gateway's /anthropic endpoint.
        // The gateway strips x-api-key and uses cf-access-token for auth.
        // We use a custom fetch to swap the headers.
        const gatewayBase = config.baseUrl ?? "https://opencode.cloudflare.dev";
        const anthropic = createAnthropic({
          apiKey: "gateway-placeholder",
          baseURL: `${gatewayBase}/anthropic`,
          headers: {
            "cf-access-token": apiKey,
            "X-Requested-With": "xmlhttprequest",
            ...(config.headers ?? {})
          },
          fetch: async (url, init) => {
            // Remove x-api-key that Anthropic SDK adds — gateway doesn't want it
            const headers = new Headers(init?.headers);
            headers.delete("x-api-key");
            headers.set("cf-access-token", apiKey);
            headers.set("X-Requested-With", "xmlhttprequest");
            return globalThis.fetch(url, { ...init, headers });
          }
        });
        return anthropic(config.model);
      }

      // Direct Anthropic API
      const anthropic = createAnthropic({
        apiKey,
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {})
      });
      return anthropic(config.model);
    }

    if (config?.provider === "openai") {
      const apiKey = config.apiKey ?? this.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("No OpenAI API key configured");
      const openai = createOpenAI({
        apiKey,
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {})
      });
      return openai(config.model);
    }

    // Default: Workers AI (no key needed)
    return createWorkersAI({ binding: this.env.AI })(
      config?.model ?? "@cf/meta/llama-4-scout-17b-16e-instruct"
    );
  }

  getSystemPrompt(): string {
    return this.context.toString();
  }

  getTools(): ToolSet {
    const config = this.getConfig();
    const workspaceTools = createWorkspaceTools(this.workspace);
    const stateProvider = stateToolsFromBackend(createWorkspaceStateBackend(this.workspace));
    const gitProvider = gitTools(this.workspace, { token: config?.githubToken });

    // Build secret bindings — each secret is tied to specific hosts
    const secretBindings: SecretBinding[] = [];
    if (config?.githubToken) {
      secretBindings.push({
        token: config.githubToken,
        hosts: ["api.github.com", "*.github.com", "raw.githubusercontent.com"],
        headerFormat: "token {token}"
      });
    }

    // Gated fetch: token in props, hostname validation, auto auth injection
    // Pattern from cloudflare-mcp — token never enters sandbox code
    const gatedFetch = (this.ctx as any).exports?.GatedFetchEntrypoint?.({
      props: { secrets: secretBindings }
    }) as Fetcher | undefined;

    const executor = new DynamicWorkerExecutor({
      loader: this.env.LOADER,
      // Use gated fetch if available, otherwise inherit network (undefined)
      globalOutbound: gatedFetch ?? undefined
    });

    const { read, write, edit, grep } = workspaceTools;
    return {
      read,
      write,
      edit,
      grep,
      code: createCodeTool({
        tools: [stateProvider, gitProvider],
        executor
      }),
      // Context memory tool — lets the LLM update project/scratchpad blocks
      ...this.context.tools()
    };
  }

  getMaxSteps(): number {
    return 25;
  }

  getWorkspace() {
    return this.workspace;
  }

  @callable()
  getMessages() {
    return this.messages;
  }

}
