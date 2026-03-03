import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest } from "agents";
import type { LanguageModel, ToolSet, UIMessage } from "ai";
import { Workspace } from "agents/workspace";
import {
  AssistantAgent,
  ExtensionManager,
  createWorkspaceTools,
  createExecuteTool,
  createExtensionTools
} from "agents/experimental/assistant";
import type {
  Session,
  ChatMessageOptions
} from "agents/experimental/assistant";

/**
 * Assistant agent with workspace tools and session management.
 *
 * Extends AssistantAgent which provides:
 * - WebSocket chat protocol (streaming, cancel, clear)
 * - Session lifecycle (create, switch, list, delete, rename)
 * - Agentic loop (context assembly → inference → tool execution → persist)
 * - Dynamic extensions (load/unload sandboxed tool plugins at runtime)
 *
 * Subclasses configure the loop declaratively via override methods.
 * Session management methods are exposed as @callable for client RPC.
 */
export class MyAssistant extends AssistantAgent {
  workspace = new Workspace(this);
  extensions = new ExtensionManager({
    loader: this.env.LOADER,
    workspace: this.workspace,
    storage: this.ctx.storage
  });

  // ── Agentic loop configuration ────────────────────────────────

  getModel(): LanguageModel {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/zai-org/glm-4.7-flash"
    );
  }

  getSystemPrompt(): string {
    return `You are a helpful coding assistant with access to a persistent workspace filesystem.

You can read, write, edit, find, and search files in the workspace. You can also execute JavaScript code in a sandboxed environment using the execute tool, and load dynamic extensions that provide additional tools.

Guidelines:
- Always read a file before editing it
- When editing, provide enough context in old_string to make the match unique
- Use the find tool to discover project structure
- Use the grep tool to search for patterns across files
- Create parent directories automatically when writing files
- Use the execute tool for multi-step operations, data transformation, or when you need branching logic
- Use load_extension to add new tool capabilities at runtime. Use only lowercase_underscore names (e.g. "math", not "basic-math-tool")
- Extension tools are prefixed with the extension name: extension "math" with tool "add" becomes "math_add"
- After loading an extension, its tools are available on the NEXT message turn — tell the user to send another message to use them`;
  }

  async onChatMessage(
    options?: ChatMessageOptions
  ): Promise<Response | undefined> {
    await this.extensions.restore();
    return super.onChatMessage(options);
  }

  getTools(): ToolSet {
    const workspaceTools = createWorkspaceTools(this.workspace);
    return {
      ...workspaceTools,
      execute: createExecuteTool({
        tools: workspaceTools,
        loader: this.env.LOADER
      }),
      ...createExtensionTools({ manager: this.extensions }),
      ...this.extensions.getTools()
    };
  }

  // ── Expose session management to the client via RPC ───────────

  @callable()
  override getSessions(): Session[] {
    return super.getSessions();
  }

  @callable()
  override createSession(name: string): Session {
    return super.createSession(name);
  }

  @callable()
  override switchSession(sessionId: string): UIMessage[] {
    return super.switchSession(sessionId);
  }

  @callable()
  override deleteSession(sessionId: string): void {
    super.deleteSession(sessionId);
  }

  @callable()
  override renameSession(sessionId: string, name: string): void {
    super.renameSession(sessionId, name);
  }

  @callable()
  override getCurrentSessionId(): string | null {
    return super.getCurrentSessionId();
  }

  @callable()
  async unloadExtension(name: string) {
    await this.extensions.restore();
    return this.extensions.unload(name);
  }

  @callable()
  async listExtensions() {
    await this.extensions.restore();
    return this.extensions.list();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
