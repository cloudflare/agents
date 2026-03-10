/**
 * E2E test worker — an AssistantAgent backed by Workers AI with workspace tools.
 */
import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest } from "agents";
import type { LanguageModel, ToolSet, UIMessage } from "ai";
import { Workspace } from "agents/experimental/workspace";
import { Think } from "../think";
import type { Session } from "../session/index";
import { createWorkspaceTools } from "../tools/workspace";

type Env = {
  TestAssistant: DurableObjectNamespace<TestAssistant>;
  AI: Ai;
  R2: R2Bucket;
};

export class TestAssistant extends Think<Env> {
  workspace = new Workspace(this, { r2: this.env.R2 });

  getModel(): LanguageModel {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/zai-org/glm-4.7-flash"
    );
  }

  getSystemPrompt(): string {
    return `You are a helpful assistant with access to a workspace filesystem.
You can read, write, edit, find, grep, and delete files.
When asked to write a file, use the write tool. When asked to read a file, use the read tool.
Always respond concisely.`;
  }

  getTools(): ToolSet {
    return createWorkspaceTools(this.workspace);
  }

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
  getMessages(): UIMessage[] {
    return this.messages;
  }

  @callable()
  getSessionHistory(sessionId: string): UIMessage[] {
    return this.sessions.getHistory(sessionId);
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
