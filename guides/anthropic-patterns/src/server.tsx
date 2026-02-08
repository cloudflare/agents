// implementing https://www.anthropic.com/research/building-effective-agents

import { type OpenAIProvider, createOpenAI } from "@ai-sdk/openai";
import {
  Agent,
  type Connection,
  type WSMessage,
  routeAgentRequest
} from "agents";
import { generateObject, generateText } from "ai";
import { z } from "zod";

type Env = {
  OPENAI_API_KEY: string;
  AI_GATEWAY_TOKEN: string;
  AI_GATEWAY_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  Sequential: DurableObjectNamespace<Agent<Env>>;
  Routing: DurableObjectNamespace<Agent<Env>>;
  Parallel: DurableObjectNamespace<Agent<Env>>;
  Orchestrator: DurableObjectNamespace<Agent<Env>>;
  Evaluator: DurableObjectNamespace<Agent<Env>>;
};

// createAgent is a helper function to generate an agent class
// with helpers for sending/receiving messages to the client and updating the status
function createAgent<
  Props extends Record<string, unknown>,
  Output extends Record<string, unknown>
>(
  _name: string,
  workflow: (
    props: Props,
    ctx: {
      toast: (message: string) => void;
      openai: OpenAIProvider;
    }
  ) => Promise<Output>
) {
  return class AnthropicAgent extends Agent<Env> {
    openai = createOpenAI({
      apiKey: this.env.OPENAI_API_KEY,
      baseURL: `https://gateway.ai.cloudflare.com/v1/${this.env.AI_GATEWAY_ACCOUNT_ID}/${this.env.AI_GATEWAY_ID}/openai`,
      headers: {
        "cf-aig-authorization": `Bearer ${this.env.AI_GATEWAY_TOKEN}`
      }
    });
    static options = {
      hibernate: true
    };
    status: {
      isRunning: boolean;
      output: string | undefined;
    } = {
      isRunning: false,
      output: undefined
    };

    onConnect(connection: Connection) {
      connection.send(
        JSON.stringify({
          status: this.status,
          type: "status"
        })
      );
    }

    toast = (message: string, type: "info" | "error" = "info") => {
      this.broadcast(
        JSON.stringify({
          toast: {
            message,
            type
          },
          type: "toast"
        })
      );
    };

    onMessage(_connection: Connection, message: WSMessage) {
      const data = JSON.parse(message as string);
      switch (data.type) {
        case "run":
          this.run({ input: data.input });
          break;
        case "stop":
          this.setStatus({ ...this.status, isRunning: false });
          break;
        default:
          console.error("Unknown message type", data.type);
      }
    }

    setStatus(status: typeof this.status) {
      this.status = status;
      this.broadcast(JSON.stringify({ status: this.status, type: "status" }));
    }

    async run(data: { input: Record<string, string> }) {
      if (this.status.isRunning) return;
      this.setStatus({ isRunning: true, output: undefined });

      try {
        const result = await workflow(data.input as Props, {
          openai: this.openai,
          toast: this.toast
        });
        this.setStatus({ isRunning: false, output: JSON.stringify(result) });
      } catch (error) {
        this.toast(`An error occurred: ${error}`);
        this.setStatus({ isRunning: false, output: JSON.stringify(error) });
      }
    }
  };
}

// Here are the patterns, implemented as simple async functions
// These were copied directly from the AI SDK examples
// https://sdk.vercel.ai/docs/foundations/agents

// A SequentialProcessing class to process tasks in a sequential manner
export const Sequential = createAgent<{ input: string }, { copy: string }>(
  "Sequential",
  async (
    props: { input: string },
    ctx: { toast: (message: string) => void; openai: OpenAIProvider }
  ) => {
    console.log("Sequential", props);
    // This agent uses a prompt chaining workflow, ideal for tasks that can be decomposed into fixed subtasks.
    // It trades off latency for higher accuracy by making each LLM call an easier task.
    const model = ctx.openai("gpt-4o");

    // First step: Generate marketing copy
    const { text: copy } = await generateText({
      model,
      prompt: `Write persuasive marketing copy for: ${props.input}. Focus on benefits and emotional appeal.`
    });
    ctx.toast("Copy generated");

    // Perform quality check on copy
    const { object: qualityMetrics } = await generateObject({
      model,
      prompt: `Evaluate this marketing copy for:
      1. Presence of call to action (true/false)
      2. Emotional appeal (1-10)
      3. Clarity (1-10)
  
      Copy to evaluate: ${copy}`,
      schema: z.object({
        clarity: z.number().min(1).max(10),
        emotionalAppeal: z.number().min(1).max(10),
        hasCallToAction: z.boolean()
      })
    });
    ctx.toast("Quality check complete");
    // If quality check fails, regenerate with more specific instructions
    if (
      !qualityMetrics.hasCallToAction ||
      qualityMetrics.emotionalAppeal < 7 ||
      qualityMetrics.clarity < 7
    ) {
      const { text: improvedCopy } = await generateText({
        model,
        prompt: `Rewrite this marketing copy with:
        ${!qualityMetrics.hasCallToAction ? "- A clear call to action" : ""}
        ${
          qualityMetrics.emotionalAppeal < 7
            ? "- Stronger emotional appeal"
            : ""
        }
        ${qualityMetrics.clarity < 7 ? "- Improved clarity and directness" : ""}
  
        Original copy: ${copy}`
      });
      return { copy: improvedCopy, qualityMetrics };
    }

    ctx.toast("Copy improved");

    return { copy, qualityMetrics };
  }
);

// A Routing class to route tasks to the appropriate agent
export const Routing = createAgent<{ query: string }, { response: string }>(
  "Routing",
  async (
    props: { query: string },
    ctx: { toast: (message: string) => void; openai: OpenAIProvider }
  ) => {
    // This agent uses a routing workflow, which classifies input and directs it to specialized follow-up tasks.
    // It is effective for complex tasks with distinct categories that are better handled separately.
    const model = ctx.openai("gpt-4o");

    // First step: Classify the query type
    const { object: classification } = await generateObject({
      model,
      prompt: `Classify this customer query:
      ${props.query}
  
      Determine:
      1. Query type (general, refund, or technical)
      2. Complexity (simple or complex)
      3. Brief reasoning for classification`,
      schema: z.object({
        complexity: z.enum(["simple", "complex"]),
        reasoning: z.string(),
        type: z.enum(["general", "refund", "technical"])
      })
    });
    ctx.toast("Query classified");
    // Route based on classification
    // Set model and system prompt based on query type and complexity
    const { text: response } = await generateText({
      model:
        classification.complexity === "simple"
          ? ctx.openai("gpt-4o-mini")
          : ctx.openai("o1-mini"),
      prompt: props.query,
      system: {
        general:
          "You are an expert customer service agent handling general inquiries.",
        refund:
          "You are a customer service agent specializing in refund requests. Follow company policy and collect necessary information.",
        technical:
          "You are a technical support specialist with deep product knowledge. Focus on clear step-by-step troubleshooting."
      }[classification.type]
    });
    ctx.toast("Response generated");
    return { classification, response };
  }
);

// A ParallelProcessing class to process tasks in parallel
export const Parallel = createAgent<
  { code: string },
  { reviews: unknown; summary: string }
>(
  "Parallel",
  async (
    props: { code: string },
    ctx: { toast: (message: string) => void; openai: OpenAIProvider }
  ) => {
    // This agent uses a parallelization workflow, effective for tasks that can be divided into independent subtasks.
    // It allows for speed and multiple perspectives, improving confidence in results.
    const model = ctx.openai("gpt-4o");

    // Run parallel reviews
    const [securityReview, performanceReview, maintainabilityReview] =
      await Promise.all([
        generateObject({
          model,
          prompt: `Review this code:
      ${props.code}`,
          schema: z.object({
            riskLevel: z.enum(["low", "medium", "high"]),
            suggestions: z.array(z.string()),
            vulnerabilities: z.array(z.string())
          }),
          system:
            "You are an expert in code security. Focus on identifying security vulnerabilities, injection risks, and authentication issues."
        }),

        generateObject({
          model,
          prompt: `Review this code:
      ${props.code}`,
          schema: z.object({
            impact: z.enum(["low", "medium", "high"]),
            issues: z.array(z.string()),
            optimizations: z.array(z.string())
          }),
          system:
            "You are an expert in code performance. Focus on identifying performance bottlenecks, memory leaks, and optimization opportunities."
        }),

        generateObject({
          model,
          prompt: `Review this code:
      ${props.code}`,
          schema: z.object({
            concerns: z.array(z.string()),
            qualityScore: z.number().min(1).max(10),
            recommendations: z.array(z.string())
          }),
          system:
            "You are an expert in code quality. Focus on code structure, readability, and adherence to best practices."
        })
      ]);

    ctx.toast("Code reviews complete");

    const reviews = [
      { ...securityReview.object, type: "security" },
      { ...performanceReview.object, type: "performance" },
      { ...maintainabilityReview.object, type: "maintainability" }
    ];

    // Aggregate results using another model instance
    const { text: summary } = await generateText({
      model,
      prompt: `Synthesize these code review results into a concise summary with key actions:
    ${JSON.stringify(reviews, null, 2)}`,
      system: "You are a technical lead summarizing multiple code reviews."
    });

    ctx.toast("Code review summary complete");

    return { reviews, summary };
  }
);

// An OrchestratorWorker class to orchestrate the workers
export const Orchestrator = createAgent<
  { featureRequest: string },
  {
    plan: {
      files: { purpose: string; filePath: string; changeType: string }[];
      estimatedComplexity: string;
    };
    changes: {
      file: { purpose: string; filePath: string; changeType: string };
      implementation: {
        code: string;
        explanation: string;
      };
    }[];
  }
>(
  "Orchestrator",
  async (
    props: { featureRequest: string },
    ctx: { toast: (message: string) => void; openai: OpenAIProvider }
  ) => {
    // This agent uses an orchestrator-workers workflow, suitable for complex tasks where subtasks aren't pre-defined.
    // It dynamically breaks down tasks and delegates them to worker LLMs, synthesizing their results.
    const { object: implementationPlan } = await generateObject({
      model: ctx.openai("o1"),
      prompt: `Analyze this feature request and create an implementation plan:
      ${props.featureRequest}`,
      schema: z.object({
        estimatedComplexity: z.enum(["low", "medium", "high"]),
        files: z.array(
          z.object({
            changeType: z.enum(["create", "modify", "delete"]),
            filePath: z.string(),
            purpose: z.string()
          })
        )
      }),
      system:
        "You are a senior software architect planning feature implementations."
    });
    ctx.toast("Implementation plan created");
    // Workers: Execute the planned changes
    const fileChanges = await Promise.all(
      implementationPlan.files.map(async (file) => {
        // Each worker is specialized for the type of change
        const workerSystemPrompt = {
          create:
            "You are an expert at implementing new files following best practices and project patterns.",
          delete:
            "You are an expert at safely removing code while ensuring no breaking changes.",
          modify:
            "You are an expert at modifying existing code while maintaining consistency and avoiding regressions."
        }[file.changeType];

        const { object: change } = await generateObject({
          model: ctx.openai("gpt-4o"),
          prompt: `Implement the changes for ${file.filePath} to support:
          ${file.purpose}
  
          Consider the overall feature ctx:
          ${props.featureRequest}`,
          schema: z.object({
            code: z.string(),
            explanation: z.string()
          }),
          system: workerSystemPrompt
        });
        ctx.toast("File change implemented");
        return {
          file,
          implementation: change
        };
      })
    );

    ctx.toast("File changes implemented");
    return {
      changes: fileChanges,
      plan: implementationPlan
    };
  }
);

// An EvaluatorOptimizer class to evaluate and optimize the agents
export const Evaluator = createAgent(
  "Evaluator",
  async (
    props: { text: string; targetLanguage: string },
    ctx: { toast: (message: string) => void; openai: OpenAIProvider }
  ) => {
    const model = ctx.openai("gpt-4o");

    let currentTranslation = "";
    let iterations = 0;
    const MAX_ITERATIONS = 1;

    // Initial translation
    const { text: translation } = await generateText({
      model: ctx.openai("gpt-4o-mini"), // use small model for first attempt
      prompt: `Translate this text to ${props.targetLanguage}, preserving tone and cultural nuances:
      ${props.text}`,
      system: "You are an expert literary translator."
    });

    ctx.toast("Initial translation complete");

    currentTranslation = translation;

    // Evaluation-optimization loop
    while (iterations < MAX_ITERATIONS) {
      // Evaluate current translation
      const { object: evaluation } = await generateObject({
        model,
        prompt: `Evaluate this translation:
  
        Original: ${props.text}
        Translation: ${currentTranslation}
  
        Consider:
        1. Overall quality
        2. Preservation of tone
        3. Preservation of nuance
        4. Cultural accuracy`,
        schema: z.object({
          culturallyAccurate: z.boolean(),
          improvementSuggestions: z.array(z.string()),
          preservesNuance: z.boolean(),
          preservesTone: z.boolean(),
          qualityScore: z.number().min(1).max(10),
          specificIssues: z.array(z.string())
        }),
        system: "You are an expert in evaluating literary translations."
      });

      ctx.toast(`Evaluation complete: ${evaluation.qualityScore}`);

      // Check if quality meets threshold
      if (
        evaluation.qualityScore >= 8 &&
        evaluation.preservesTone &&
        evaluation.preservesNuance &&
        evaluation.culturallyAccurate
      ) {
        break;
      }

      // Generate improved translation based on feedback
      const { text: improvedTranslation } = await generateText({
        model: ctx.openai("gpt-4o"), // use a larger model
        prompt: `Improve this translation based on the following feedback:
        ${evaluation.specificIssues.join("\n")}
        ${evaluation.improvementSuggestions.join("\n")}
  
        Original: ${props.text}
        Current Translation: ${currentTranslation}`,
        system: "You are an expert literary translator."
      });

      ctx.toast("Improved translation complete");

      currentTranslation = improvedTranslation;
      iterations++;
    }

    ctx.toast("Final translation complete");

    return {
      finalTranslation: currentTranslation,
      iterationsRequired: iterations
    };
  }
);

export default {
  async fetch(request, env, _ctx) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
