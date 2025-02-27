// implementing https://www.anthropic.com/research/building-effective-agents

import {
  Agent,
  type AgentNamespace,
  routeAgentRequest,
  type Connection,
  type WSMessage,
} from "agents-sdk";
import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import { generateText, generateObject } from "ai";
import { z } from "zod";

type Env = {
  OPENAI_API_KEY: string;
  AI_GATEWAY_TOKEN: string;
  AI_GATEWAY_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  Sequential: AgentNamespace<Agent<Env>>;
  Routing: AgentNamespace<Agent<Env>>;
  Parallel: AgentNamespace<Agent<Env>>;
  Orchestrator: AgentNamespace<Agent<Env>>;
  Evaluator: AgentNamespace<Agent<Env>>;
};

// createAgent is a helper function to generate an agent class
// with helpers for sending/receiving messages to the client and updating the status
function createAgent(
  name: string,
  workflow: (
    props: any,
    ctx: {
      toast: (message: string) => void;
      openai: OpenAIProvider;
    }
  ) => Promise<any>
) {
  return class AnthropicAgent extends Agent<Env> {
    openai = createOpenAI({
      apiKey: this.env.OPENAI_API_KEY,
      baseURL: `https://gateway.ai.cloudflare.com/v1/${this.env.AI_GATEWAY_ACCOUNT_ID}/${this.env.AI_GATEWAY_ID}/openai`,
      headers: {
        "cf-aig-authorization": `Bearer ${this.env.AI_GATEWAY_TOKEN}`,
      },
    });
    static options = {
      hibernate: true,
    };
    status: {
      isRunning: boolean;
      output: any;
    } = {
      isRunning: false,
      output: undefined,
    };

    onConnect(connection: Connection) {
      connection.send(
        JSON.stringify({
          type: "status",
          status: this.status,
        })
      );
    }

    toast = (message: string, type: "info" | "error" = "info") => {
      this.broadcast(
        JSON.stringify({
          type: "toast",
          toast: {
            message,
            type,
          },
        })
      );
    };

    onMessage(connection: Connection, message: WSMessage) {
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
      this.broadcast(JSON.stringify({ type: "status", status: this.status }));
    }

    async run(data: { input: any }) {
      if (this.status.isRunning) return;
      this.setStatus({ isRunning: true, output: undefined });

      try {
        const result = await workflow(data.input, {
          toast: this.toast,
          openai: this.openai,
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
export const Sequential = createAgent(
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
      prompt: `Write persuasive marketing copy for: ${props.input}. Focus on benefits and emotional appeal.`,
    });
    ctx.toast("Copy generated");

    // Perform quality check on copy
    const { object: qualityMetrics } = await generateObject({
      model,
      schema: z.object({
        hasCallToAction: z.boolean(),
        emotionalAppeal: z.number().min(1).max(10),
        clarity: z.number().min(1).max(10),
      }),
      prompt: `Evaluate this marketing copy for:
      1. Presence of call to action (true/false)
      2. Emotional appeal (1-10)
      3. Clarity (1-10)
  
      Copy to evaluate: ${copy}`,
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
  
        Original copy: ${copy}`,
      });
      return { copy: improvedCopy, qualityMetrics };
    }

    ctx.toast("Copy improved");

    return { copy, qualityMetrics };
  }
);

// A Routing class to route tasks to the appropriate agent
export const Routing = createAgent(
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
      schema: z.object({
        reasoning: z.string(),
        type: z.enum(["general", "refund", "technical"]),
        complexity: z.enum(["simple", "complex"]),
      }),
      prompt: `Classify this customer query:
      ${props.query}
  
      Determine:
      1. Query type (general, refund, or technical)
      2. Complexity (simple or complex)
      3. Brief reasoning for classification`,
    });
    ctx.toast("Query classified");
    // Route based on classification
    // Set model and system prompt based on query type and complexity
    const { text: response } = await generateText({
      model:
        classification.complexity === "simple"
          ? ctx.openai("gpt-4o-mini")
          : ctx.openai("o1-mini"),
      system: {
        general:
          "You are an expert customer service agent handling general inquiries.",
        refund:
          "You are a customer service agent specializing in refund requests. Follow company policy and collect necessary information.",
        technical:
          "You are a technical support specialist with deep product knowledge. Focus on clear step-by-step troubleshooting.",
      }[classification.type],
      prompt: props.query,
    });
    ctx.toast("Response generated");
    return { response, classification };
  }
);

// A ParallelProcessing class to process tasks in parallel
export const Parallel = createAgent(
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
          system:
            "You are an expert in code security. Focus on identifying security vulnerabilities, injection risks, and authentication issues.",
          schema: z.object({
            vulnerabilities: z.array(z.string()),
            riskLevel: z.enum(["low", "medium", "high"]),
            suggestions: z.array(z.string()),
          }),
          prompt: `Review this code:
      ${props.code}`,
        }),

        generateObject({
          model,
          system:
            "You are an expert in code performance. Focus on identifying performance bottlenecks, memory leaks, and optimization opportunities.",
          schema: z.object({
            issues: z.array(z.string()),
            impact: z.enum(["low", "medium", "high"]),
            optimizations: z.array(z.string()),
          }),
          prompt: `Review this code:
      ${props.code}`,
        }),

        generateObject({
          model,
          system:
            "You are an expert in code quality. Focus on code structure, readability, and adherence to best practices.",
          schema: z.object({
            concerns: z.array(z.string()),
            qualityScore: z.number().min(1).max(10),
            recommendations: z.array(z.string()),
          }),
          prompt: `Review this code:
      ${props.code}`,
        }),
      ]);

    ctx.toast("Code reviews complete");

    const reviews = [
      { ...securityReview.object, type: "security" },
      { ...performanceReview.object, type: "performance" },
      { ...maintainabilityReview.object, type: "maintainability" },
    ];

    // Aggregate results using another model instance
    const { text: summary } = await generateText({
      model,
      system: "You are a technical lead summarizing multiple code reviews.",
      prompt: `Synthesize these code review results into a concise summary with key actions:
    ${JSON.stringify(reviews, null, 2)}`,
    });

    ctx.toast("Code review summary complete");

    return { reviews, summary };
  }
);

// An OrchestratorWorker class to orchestrate the workers
export const Orchestrator = createAgent(
  "Orchestrator",
  async (
    props: { featureRequest: string },
    ctx: { toast: (message: string) => void; openai: OpenAIProvider }
  ) => {
    // This agent uses an orchestrator-workers workflow, suitable for complex tasks where subtasks aren't pre-defined.
    // It dynamically breaks down tasks and delegates them to worker LLMs, synthesizing their results.
    const { object: implementationPlan } = await generateObject({
      model: ctx.openai("o1"),
      schema: z.object({
        files: z.array(
          z.object({
            purpose: z.string(),
            filePath: z.string(),
            changeType: z.enum(["create", "modify", "delete"]),
          })
        ),
        estimatedComplexity: z.enum(["low", "medium", "high"]),
      }),
      system:
        "You are a senior software architect planning feature implementations.",
      prompt: `Analyze this feature request and create an implementation plan:
      ${props.featureRequest}`,
    });
    ctx.toast("Implementation plan created");
    // Workers: Execute the planned changes
    const fileChanges = await Promise.all(
      implementationPlan.files.map(async (file) => {
        // Each worker is specialized for the type of change
        const workerSystemPrompt = {
          create:
            "You are an expert at implementing new files following best practices and project patterns.",
          modify:
            "You are an expert at modifying existing code while maintaining consistency and avoiding regressions.",
          delete:
            "You are an expert at safely removing code while ensuring no breaking changes.",
        }[file.changeType];

        const { object: change } = await generateObject({
          model: ctx.openai("gpt-4o"),
          schema: z.object({
            explanation: z.string(),
            code: z.string(),
          }),
          system: workerSystemPrompt,
          prompt: `Implement the changes for ${file.filePath} to support:
          ${file.purpose}
  
          Consider the overall feature ctx:
          ${props.featureRequest}`,
        });
        ctx.toast("File change implemented");
        return {
          file,
          implementation: change,
        };
      })
    );

    ctx.toast("File changes implemented");
    return {
      plan: implementationPlan,
      changes: fileChanges,
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
      system: "You are an expert literary translator.",
      prompt: `Translate this text to ${props.targetLanguage}, preserving tone and cultural nuances:
      ${props.text}`,
    });

    ctx.toast("Initial translation complete");

    currentTranslation = translation;

    // Evaluation-optimization loop
    while (iterations < MAX_ITERATIONS) {
      // Evaluate current translation
      const { object: evaluation } = await generateObject({
        model,
        schema: z.object({
          qualityScore: z.number().min(1).max(10),
          preservesTone: z.boolean(),
          preservesNuance: z.boolean(),
          culturallyAccurate: z.boolean(),
          specificIssues: z.array(z.string()),
          improvementSuggestions: z.array(z.string()),
        }),
        system: "You are an expert in evaluating literary translations.",
        prompt: `Evaluate this translation:
  
        Original: ${props.text}
        Translation: ${currentTranslation}
  
        Consider:
        1. Overall quality
        2. Preservation of tone
        3. Preservation of nuance
        4. Cultural accuracy`,
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
        system: "You are an expert literary translator.",
        prompt: `Improve this translation based on the following feedback:
        ${evaluation.specificIssues.join("\n")}
        ${evaluation.improvementSuggestions.join("\n")}
  
        Original: ${props.text}
        Current Translation: ${currentTranslation}`,
      });

      ctx.toast("Improved translation complete");

      currentTranslation = improvedTranslation;
      iterations++;
    }

    ctx.toast("Final translation complete");

    return {
      finalTranslation: currentTranslation,
      iterationsRequired: iterations,
    };
  }
);

async function getCachedResponse(
  request: Request,
  or: () => Response | Promise<Response>
) {
  // @ts-ignore mixing browser and server types here
  const cache: Cache = caches.default;
  const response = await cache.match(request);
  if (response) {
    return response;
  }
  const newResponse = await or();
  await cache.put(request, newResponse.clone());
  return newResponse;
}

export default {
  async fetch(request, env, _ctx) {
    // // bring thi back when we figure out SSR
    // const pathname = new URL(request.url).pathname;
    // if (pathname === "/") {
    //   return getCachedResponse(
    //     request,
    //     () =>
    //       new Response(
    //         renderToString(
    //           <Layout>
    //             <App />
    //           </Layout>
    //         ),
    //         {
    //           headers: {
    //             "Content-Type": "text/html",
    //           },
    //         }
    //       )
    //   );
    // }
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
