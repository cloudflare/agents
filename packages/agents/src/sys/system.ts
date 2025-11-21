/**
 * This creates a Durable Object class that needs to be exported, so wrangler can read it.
 * Make sure you add the binding `DEEP_AGENT` in your `wrangler.jsonc` file.
 */

import { SystemAgent, type AgentEnv } from "./agent";
import { AgentEventType } from "./events";
import { planning, filesystem, subagents, getToolMeta } from "./middleware";
import { makeOpenAI, type Provider } from "./providers";
import type {
  ToolHandler,
  AgentMiddleware,
  AgentBlueprint,
  AgentConfig
} from "./types";
import { createHandler, type HandlerOptions } from "./worker";

type AgentSystemOptions = {
  defaultModel: string;
  provider?: Provider;
  handlerOptions?: HandlerOptions;
};

class ToolRegistry {
  private tools = new Map<string, ToolHandler>();
  private tags = new Map<string, string[]>(); // Map<tag, toolNames>

  addTool(name: string, handler: ToolHandler, tags?: string[]) {
    this.tools.set(name, handler);
    if (tags) {
      for (const tag of tags) {
        const tools = this.tags.get(tag) || [];
        tools.push(name);
        this.tags.set(tag, tools);
      }
    }
  }

  select(tools: string[], tags: string[]): ToolHandler[] {
    const selected = [];
    for (const tool of tools) {
      selected.push(this.tools.get(tool)!);
    }
    for (const tag of tags) {
      let tools = this.tags.get(tag);
      if (!tools) {
        console.warn(`No tools found for tag ${tag}`);
        tools = [];
      }
      selected.push(...tools.map((t) => this.tools.get(t)!));
    }
    return selected;
  }
}

class MiddlewareRegistry {
  private middlewares = new Map<string, AgentMiddleware>();
  private tags = new Map<string, string[]>(); // Map<tag, middlewareNames>

  addMiddleware(name: string, handler: AgentMiddleware, tags?: string[]) {
    this.middlewares.set(name, handler);
    if (tags) {
      for (const tag of tags) {
        const tools = this.tags.get(tag) || [];
        tools.push(name);
        this.tags.set(tag, tools);
      }
    }
  }

  select(tools: string[], tags: string[]): AgentMiddleware[] {
    const selected = [];
    for (const tool of tools) {
      selected.push(this.middlewares.get(tool)!);
    }
    for (const tag of tags) {
      let tools = this.tags.get(tag);
      if (!tools) {
        console.warn(`No tools found for tag ${tag}`);
        tools = [];
      }
      selected.push(...tools.map((t) => this.middlewares.get(t)!));
    }
    return selected;
  }
}

export class AgentSystem<TConfig = Record<string, unknown>> {
  toolRegistry = new ToolRegistry();
  middlewareRegistry = new MiddlewareRegistry();
  agentRegistry = new Map<string, AgentBlueprint>();
  config: Record<string, AgentConfig> = {};
  // private defaultMiddlewares: AgentMiddleware[] = [];

  constructor(private options: AgentSystemOptions) {}

  defaults() {
    return this.use(planning, ["default"])
      .use(filesystem, ["default"])
      .use(subagents, ["default"]);
  }

  addTool(handler: ToolHandler, tags?: string[]): AgentSystem<TConfig> {
    const toolName = getToolMeta(handler)?.name;
    if (!toolName) throw new Error("Tool missing name: use defineTool(...)");
    this.toolRegistry.addTool(toolName, handler, tags);

    return this;
  }

  use<TNewConfig>(
    mw: AgentMiddleware<TNewConfig>,
    tags?: string[]
  ): AgentSystem<TConfig & TNewConfig> {
    const uniqueTags = Array.from(new Set([...(tags || []), ...mw.tags]));
    this.middlewareRegistry.addMiddleware(mw.name, mw, uniqueTags);
    return this as unknown as AgentSystem<TConfig & TNewConfig>;
  }

  addAgent(blueprint: AgentBlueprint<Partial<TConfig>>): AgentSystem<TConfig> {
    this.agentRegistry.set(blueprint.name, blueprint);
    return this;
  }

  export(): {
    SystemAgent: typeof SystemAgent<AgentEnv>;
    handler: ReturnType<typeof createHandler>;
  } {
    const { toolRegistry, middlewareRegistry, agentRegistry, options } = this;
    class ConfiguredAgentSystem extends SystemAgent<AgentEnv> {
      async onDone(ctx: { agent: SystemAgent; final: string }): Promise<void> {
        // throw new Error("Method not implemented.");
      }

      get tools() {
        if (!this.info.agentType) throw new Error("Agent type not set");

        const blueprint = agentRegistry.get(this.info.agentType);
        if (!blueprint) throw new Error("Agent type not found");

        const tools = toolRegistry.select([], blueprint.tags);
        return {
          ...Object.fromEntries(tools.map((t) => [getToolMeta(t)!.name, t])),
          ...this._tools
        };
      }

      get middleware() {
        if (!this.info.agentType) throw new Error("Agent type not set");

        const blueprint = agentRegistry.get(this.info.agentType);
        if (!blueprint) throw new Error("Agent type not found");

        const middleware = middlewareRegistry.select([], blueprint.tags);
        return middleware;
      }

      get model() {
        if (!this.info.agentType) throw new Error("Agent type not set");

        const blueprint = agentRegistry.get(this.info.agentType);
        if (!blueprint) throw new Error("Agent type not found");

        return blueprint.model ?? options.defaultModel;
      }

      get systemPrompt(): string {
        if (!this.info.agentType) throw new Error("Agent type not set");

        const blueprint = agentRegistry.get(this.info.agentType);
        if (!blueprint) throw new Error("Agent type not found");

        return blueprint.prompt;
      }

      get config(): AgentConfig {
        if (!this.info.agentType) throw new Error("Agent type not set");

        const blueprint = agentRegistry.get(this.info.agentType);
        if (!blueprint) throw new Error("Agent type not found");

        return blueprint.config ?? { middleware: {}, tools: {} };
      }

      get provider(): Provider {
        let baseProvider = options?.provider;
        // Set OpenAI (chat completions really) provider if not set
        if (!baseProvider) {
          const apiKey = this.env.LLM_API_KEY;
          const apiBase = this.env.LLM_API_BASE;
          if (!apiKey)
            throw new Error("Neither LLM_API_KEY nor custom provider set");

          baseProvider = makeOpenAI(apiKey, apiBase);
        }

        return {
          invoke: async (req, opts) => {
            this.emit(AgentEventType.MODEL_STARTED, {
              model: req.model
            });
            const out = await baseProvider.invoke(req, opts);
            this.emit(AgentEventType.MODEL_COMPLETED, {
              usage: {
                inputTokens: out.usage?.promptTokens ?? 0,
                outputTokens: out.usage?.completionTokens ?? 0
              }
            });
            return out;
          },
          stream: async (req, onDelta) => {
            this.emit(AgentEventType.MODEL_STARTED, {
              model: req.model
            });
            const out = await baseProvider.stream(req, (d) => {
              this.emit(AgentEventType.MODEL_DELTA, { delta: d });
              onDelta(d);
            });
            this.emit(AgentEventType.MODEL_COMPLETED, {
              usage: undefined
            });
            return out;
          }
        };
      }
    }
    const handlerOptions = { ...options?.handlerOptions };
    if (!handlerOptions.agentDefinitions) {
      handlerOptions.agentDefinitions = Array.from(this.agentRegistry.values());
    }
    const handler = createHandler(handlerOptions);
    return { SystemAgent: ConfiguredAgentSystem, handler };
  }
}
