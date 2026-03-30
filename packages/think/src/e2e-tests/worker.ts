/**
 * E2E test worker — a Think agent backed by Workers AI with workspace tools.
 */
import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest } from "agents";
import type { LanguageModel, ToolSet, UIMessage } from "ai";
import { Workspace } from "@cloudflare/shell";
import { Think } from "../think";
import { createWorkspaceTools } from "../tools/workspace";

type Env = {
  TestAssistant: DurableObjectNamespace<TestAssistant>;
  AI: Ai;
  R2: R2Bucket;
};

export class TestAssistant extends Think<Env> {
  workspace = new Workspace({
    sql: this.ctx.storage.sql,
    r2: this.env.R2,
    name: () => this.name
  });

  getModel(): LanguageModel {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.5",
      { sessionAffinity: this.sessionAffinity }
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
  override getMessages(): UIMessage[] {
    return this.messages;
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
