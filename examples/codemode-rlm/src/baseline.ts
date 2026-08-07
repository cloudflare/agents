import { Think, type TurnConfig, type TurnContext } from "@cloudflare/think";
import type { SessionMessage } from "agents/experimental/memory/session";
import { jsonSchema, tool, type ToolSet } from "ai";
import {
  MAX_INPUT_CHARS,
  boundedInteger,
  isRecord,
  modelReasoningEffort,
  requireString
} from "./core";

const BASELINE_PROMPT = `You are a basic Think agent in a controlled reasoning evaluation.

Solve the user's task directly from the supplied material. You have no web, MCP, benchmark-answer lookup, or puzzle-specific helper. Follow the requested response schema exactly and do not wrap the answer in Markdown.

Completing a best-effort answer is more important than exhaustive analysis. Keep reasoning concise, commit to the most plausible rule once you have checked it against the demonstrations, and submit the requested final answer through submit_answer even when uncertain.`;

function messageText(message: SessionMessage | undefined): string {
  if (!message) return "";
  return message.parts
    .filter(
      (part): part is typeof part & { text: string } =>
        part.type === "text" && typeof part.text === "string"
    )
    .map((part) => part.text)
    .join("");
}

/** A direct Think control with only an evaluation answer tool active. */
export class BasicThinkAgent extends Think<Env> {
  override includeMcpTools = false;
  override fetchTools: false = false;
  override chatRecovery = true;

  #answer = "";

  override getModel(): string {
    return this.env.MODEL || "@cf/moonshotai/kimi-k2.7-code";
  }

  override getSystemPrompt(): string {
    return BASELINE_PROMPT;
  }

  override getTools(): ToolSet {
    return {
      submit_answer: tool({
        description:
          "Submit the complete final answer in exactly the format requested by the user. Calling this ends the evaluation turn.",
        inputSchema: jsonSchema<{ content: string }>({
          type: "object",
          properties: {
            content: {
              type: "string",
              minLength: 1,
              maxLength: MAX_INPUT_CHARS
            }
          },
          required: ["content"],
          additionalProperties: false
        }),
        execute: async ({ content }) => {
          this.#answer = requireString(content, "content", {
            min: 1,
            max: MAX_INPUT_CHARS
          });
          return { accepted: true };
        }
      })
    };
  }

  override beforeTurn(_ctx: TurnContext): TurnConfig {
    return {
      instructions: BASELINE_PROMPT,
      activeTools: ["submit_answer"],
      toolChoice: { type: "tool", toolName: "submit_answer" },
      maxSteps: boundedInteger(this.env.MAX_STEPS, 12, 2, 40),
      stopWhen: () => Boolean(this.#answer),
      maxOutputTokens: 32_768,
      maxRetries: 2,
      providerOptions: {
        "workers-ai": {
          reasoning_effort: modelReasoningEffort(this.env.REASONING_EFFORT)
        }
      },
      timeout: {
        totalMs: boundedInteger(
          this.env.TURN_TIMEOUT_MS,
          180_000,
          10_000,
          900_000
        )
      },
      chatStreamStallTimeoutMs: 0
    };
  }

  async evaluate(body: unknown): Promise<Record<string, unknown>> {
    if (!isRecord(body)) throw new Error("JSON body must be an object");
    const task = requireString(body.task, "task", {
      min: 1,
      max: MAX_INPUT_CHARS
    });
    if (body.context !== undefined && body.material !== undefined) {
      throw new Error("send either context or material, not both");
    }
    const material = requireString(
      body.context ?? body.material ?? "",
      "context",
      { max: MAX_INPUT_CHARS }
    );
    this.#answer = "";
    const result = await this.runTurn({
      mode: "wait",
      input: `${task}\n\n<material>\n${material}\n</material>`,
      channel: "web"
    });
    if (result.status !== "completed") {
      return {
        status: "error",
        error: result.error ?? `basic Think turn ended with ${result.status}`
      };
    }
    const answer = this.#answer || messageText(result.message);
    return answer
      ? {
          status: "completed",
          answer,
          requestId: result.requestId
        }
      : {
          status: "error",
          error: "basic Think completed without a text answer"
        };
  }
}
