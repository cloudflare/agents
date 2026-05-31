import type { LanguageModel, ToolSet } from "ai";
import type { Session } from "agents/experimental/memory/session";
import { Think } from "../think";
import type { SkillScriptRunner, SkillSource } from "agents/skills";
import type { ThinkMessengers } from "../messengers";
import type { ThinkScheduledTasks } from "../think";

export const THINK_AGENT_DEFINITION = Symbol.for(
  "cloudflare.think.agent.definition"
);

export interface DeclarativeThinkAgentOptions<
  Env extends Cloudflare.Env = Cloudflare.Env
> {
  model: LanguageModel | ((env: Env) => LanguageModel);
  prompt?: string | ((env: Env) => string);
  tools?: ToolSet | ((env: Env) => ToolSet);
  skills?: SkillSource[] | ((env: Env) => SkillSource[]);
  skillScriptRunner?:
    | SkillScriptRunner
    | ((agent: Think<Cloudflare.Env>) => SkillScriptRunner);
  schedules?: ThinkScheduledTasks | ((env: Env) => ThinkScheduledTasks);
  messengers?: ThinkMessengers | ((env: Env) => ThinkMessengers);
  configureSession?: (
    session: Session,
    agent: Think<Env>
  ) => Session | Promise<Session>;
}

export interface DeclarativeThinkAgentDefinition<
  Env extends Cloudflare.Env = Cloudflare.Env
> {
  readonly [THINK_AGENT_DEFINITION]: true;
  readonly kind: "think-agent-definition";
  readonly options: DeclarativeThinkAgentOptions<Env>;
  __toThinkClass(className: string): typeof Think<Env>;
}

export function agent<Env extends Cloudflare.Env = Cloudflare.Env>(
  options: DeclarativeThinkAgentOptions<Env>
): DeclarativeThinkAgentDefinition<Env> {
  return {
    [THINK_AGENT_DEFINITION]: true,
    kind: "think-agent-definition",
    options,
    __toThinkClass(className) {
      const definition = options;
      const Generated = class extends Think<Env> {
        getModel() {
          return resolveEnvValue(definition.model, this.env);
        }

        getSystemPrompt() {
          const prompt = definition.prompt;
          return prompt === undefined
            ? super.getSystemPrompt()
            : resolveEnvValue(prompt, this.env);
        }

        getTools() {
          const tools = definition.tools;
          return tools === undefined
            ? super.getTools()
            : resolveEnvValue(tools, this.env);
        }

        getSkills() {
          const skills = definition.skills;
          return skills === undefined
            ? super.getSkills()
            : resolveEnvValue(skills, this.env);
        }

        getSkillScriptRunner() {
          const runner = definition.skillScriptRunner;
          if (runner === undefined) return super.getSkillScriptRunner();
          return typeof runner === "function"
            ? (runner as (agent: Think<Cloudflare.Env>) => SkillScriptRunner)(
                this as unknown as Think<Cloudflare.Env>
              )
            : runner;
        }

        getScheduledTasks() {
          const schedules = definition.schedules;
          return schedules === undefined
            ? super.getScheduledTasks()
            : resolveEnvValue(schedules, this.env);
        }

        getMessengers() {
          const messengers = definition.messengers;
          return messengers === undefined
            ? super.getMessengers()
            : resolveEnvValue(messengers, this.env);
        }

        configureSession(session: Session) {
          return (
            definition.configureSession?.(session, this) ??
            super.configureSession(session)
          );
        }
      };
      Object.defineProperty(Generated, "name", { value: className });
      return Generated as unknown as typeof Think<Env>;
    }
  };
}

function resolveEnvValue<Env extends Cloudflare.Env, Value>(
  value: Value | ((env: Env) => Value),
  env: Env
): Value {
  return typeof value === "function"
    ? (value as (env: Env) => Value)(env)
    : value;
}
