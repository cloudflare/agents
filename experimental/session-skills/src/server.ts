/**
 * Session Skills Example — rewritten with Think
 *
 * Think handles the entire chat lifecycle (streaming, tool calls,
 * message persistence, WebSocket protocol). This file only contains:
 *   - Model + session configuration
 *   - Skills CRUD callables for the sidebar
 */

import { callable, routeAgentRequest } from "agents";
import { R2SkillProvider } from "agents/experimental/memory/session";
import { createCompactFunction } from "agents/experimental/memory/utils";
import { generateText } from "ai";
import type { Session } from "@cloudflare/think";
import { Think } from "@cloudflare/think";
import { createWorkersAI } from "workers-ai-provider";

export interface Skill {
  key: string;
  description?: string;
  size?: number;
}

export class SkillsAgent extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.5",
      { sessionAffinity: this.sessionAffinity }
    );
  }

  configureSession(session: Session) {
    return session
      .withContext("soul", {
        provider: {
          get: async () =>
            [
              "You are a helpful assistant with access to skills.",
              "When a user asks you to do something, check the SKILLS section for a relevant skill and use load_context to load it.",
              "Use set_context to save important facts to memory."
            ].join("\n")
        }
      })
      .withContext("memory", {
        description: "Learned facts — save important things here",
        maxTokens: 1100
      })
      .withContext("skills", {
        provider: new R2SkillProvider(this.env.SKILLS_BUCKET, {
          prefix: "skills/"
        })
      })
      .onCompaction(
        createCompactFunction({
          summarize: (prompt) =>
            generateText({
              model: createWorkersAI({ binding: this.env.AI })(
                "@cf/zai-org/glm-4.7-flash"
              ),
              prompt
            }).then((r) => r.text),
          tailTokenBudget: 150,
          minTailMessages: 1
        })
      )
      .compactAfter(1000)
      .withCachedPrompt();
  }

  // ── Skills management (called from sidebar) ─────────────────────

  @callable()
  async listSkills(): Promise<Skill[]> {
    const listed = await this.env.SKILLS_BUCKET.list({
      prefix: "skills/",
      include: ["customMetadata"]
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    return listed.objects.map((obj) => ({
      key: obj.key.slice("skills/".length),
      description: obj.customMetadata?.description,
      size: obj.size
    }));
  }

  @callable()
  async getSkill(key: string): Promise<string | null> {
    const obj = await this.env.SKILLS_BUCKET.get(`skills/${key}`);
    return obj ? obj.text() : null;
  }

  @callable()
  async saveSkill(
    key: string,
    content: string,
    description?: string
  ): Promise<{ success: boolean }> {
    const provider = new R2SkillProvider(this.env.SKILLS_BUCKET, {
      prefix: "skills/"
    });
    await provider.set(key, content, description);
    return { success: true };
  }

  @callable()
  async deleteSkill(key: string): Promise<{ success: boolean }> {
    await this.env.SKILLS_BUCKET.delete(`skills/${key}`);
    return { success: true };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
