/**
 * Counts how often each tool-set builder runs across turns and continuations,
 * and whether the built tool objects are reused. Backs tool-memo.test.ts.
 */
import type { LanguageModel, ToolSet } from "ai";
import { z } from "zod";
import { action, skills, Think } from "../../think";
import type { Action, TurnConfig, TurnContext } from "../../think";
import type { SkillSource } from "agents/skills";

export type ToolMemoSnapshot = {
  getToolsCalls: number;
  getActionsCalls: number;
  skillListCalls: number;
  skillRefreshCalls: number;
  /** Per inference attempt: whether each tool object is the one from attempt 0. */
  attempts: Array<{
    continuation: boolean;
    sameWorkspaceTool: boolean;
    sameActionTool: boolean;
    sameSkillTool: boolean;
    sameContextTool: boolean;
  }>;
};

const finishReason = { unified: "stop" as const, raw: undefined };
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 }
};

function createTextModel(): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "tool-memo-model",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream() {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "text" });
          controller.enqueue({ type: "text-delta", id: "text", delta: "ok" });
          controller.enqueue({ type: "text-end", id: "text" });
          controller.enqueue({ type: "finish", finishReason, usage });
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

const echoAction = action({
  name: "echo",
  description: "Echo the input",
  inputSchema: z.object({ text: z.string() }),
  approval: true,
  execute: async ({ text }: { text: string }) => text
});

export class ThinkToolMemoTestAgent extends Think {
  override maxSteps = 1;

  private _getToolsCalls = 0;
  private _getActionsCalls = 0;
  private _skillListCalls = 0;
  private _skillRefreshCalls = 0;
  private _firstTools: ToolSet | null = null;
  private _attempts: ToolMemoSnapshot["attempts"] = [];

  override getModel(): LanguageModel {
    return createTextModel();
  }

  override configureContext() {
    return [
      {
        label: "notes",
        description: "Scratch notes",
        provider: {
          get: async () => "none",
          set: async () => {}
        }
      }
    ];
  }

  override getTools(): ToolSet {
    this._getToolsCalls++;
    return {};
  }

  override getActions(): Record<string, Action> {
    this._getActionsCalls++;
    return { echo: echoAction };
  }

  override getSkills(): SkillSource[] {
    const base = skills.fromManifest({
      id: "memo-skills",
      fingerprint: "v1",
      skills: [
        {
          name: "knot-tying",
          description: "How to tie useful knots.",
          body: "Always double-check the hitch."
        }
      ]
    });
    return [
      {
        id: base.id,
        fingerprint: base.fingerprint,
        list: () => {
          this._skillListCalls++;
          return base.list();
        },
        load: (name) => base.load(name),
        refresh: async () => {
          this._skillRefreshCalls++;
        }
      }
    ];
  }

  override beforeTurn(ctx: TurnContext): TurnConfig {
    const first = (this._firstTools ??= ctx.tools);
    this._attempts.push({
      continuation: ctx.continuation,
      sameWorkspaceTool: ctx.tools.read === first.read,
      sameActionTool: ctx.tools.echo === first.echo,
      sameSkillTool: ctx.tools.activate_skill === first.activate_skill,
      sameContextTool: ctx.tools.set_context === first.set_context
    });
    return {};
  }

  setSkillsRefreshForTest(policy: Think["skillsRefresh"]): void {
    this.skillsRefresh = policy;
  }

  async runTurnForTest(text: string): Promise<{ status: string }> {
    const { status } = await this.runTurn({ mode: "wait", input: text });
    return { status };
  }

  async runContinuationForTest(): Promise<{ status: string }> {
    const { status } = await this.runTurn({ mode: "wait", continuation: true });
    return { status };
  }

  snapshotForTest(): ToolMemoSnapshot {
    return {
      getToolsCalls: this._getToolsCalls,
      getActionsCalls: this._getActionsCalls,
      skillListCalls: this._skillListCalls,
      skillRefreshCalls: this._skillRefreshCalls,
      attempts: [...this._attempts]
    };
  }
}
