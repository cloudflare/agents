import { DurableObject } from "cloudflare:workers";
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  ToolTask,
  type ToolExecutionResult,
  type ToolRegistration
} from "@earendil-works/pi-durable";
import { routeAgentRequest } from "agents";
import { Lifecycle } from "agents/lifecycle";
import { fromManifest } from "agents/skills";
import { WebSockets } from "agents/websockets";
import { Driver } from "./driver";
import { PiHarness } from "./harness/pi-harness";
import { PiSessionSockets } from "./sockets";
import { createModels } from "./providers/models";
import { workersAI } from "./providers/workers-ai";

const MEMORY_PREFIX = "pi-playground:memory:";
const MODEL_ID = "@cf/moonshotai/kimi-k2.7-code";

type Operation =
  | "add"
  | "subtract"
  | "multiply"
  | "divide"
  | "+"
  | "-"
  | "*"
  | "/";

function text(content: string, details?: JsonValue): ToolExecutionResult {
  return {
    content: [{ type: "text", text: content }],
    ...(details === undefined ? {} : { details })
  };
}

/** pi validates arguments against `parameters` before `execute` runs. */
function argsOf<T>(args: JsonValue): T {
  return args as T;
}

function calculate(operation: Operation, left: number, right: number): number {
  switch (operation) {
    case "add":
    case "+":
      return left + right;
    case "subtract":
    case "-":
      return left - right;
    case "multiply":
    case "*":
      return left * right;
    case "divide":
    case "/":
      if (right === 0) throw new Error("Cannot divide by zero");
      return left / right;
  }
}

/**
 * The playground's tools. `replay: "safe"` lets pi run a call again after an
 * eviction interrupted it; every other call is reported to the model as
 * interrupted instead.
 */
function createTools(storage: DurableObjectStorage): ToolRegistration[] {
  return [
    {
      name: "calculate",
      description: "Perform exact arithmetic with two numbers.",
      parameters: Type.Object({
        operation: Type.Union(
          (
            [
              "add",
              "subtract",
              "multiply",
              "divide",
              "+",
              "-",
              "*",
              "/"
            ] as const
          ).map((value) => Type.Literal(value))
        ),
        left: Type.Number(),
        right: Type.Number()
      }),
      replay: "safe",
      async execute(args) {
        const input = argsOf<{
          operation: Operation;
          left: number;
          right: number;
        }>(args);
        const result = calculate(input.operation, input.left, input.right);
        return text(String(result), { result });
      }
    },
    {
      name: "roll_dice",
      description: "Roll one or more fair dice.",
      parameters: Type.Object({
        sides: Type.Integer({ minimum: 2, maximum: 1000 }),
        count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 }))
      }),
      async execute(args, api) {
        const input = argsOf<{ sides: number; count?: number }>(args);
        const count = input.count ?? 1;
        api.output(`Rolling ${count}d${input.sides}…\n`);
        const rolls = Array.from(
          { length: count },
          () => Math.floor(Math.random() * input.sides) + 1
        );
        const total = rolls.reduce((sum, roll) => sum + roll, 0);
        return text(`Rolled ${rolls.join(", ")} (total ${total})`, {
          rolls,
          total
        });
      }
    },
    {
      name: "remember",
      description: "Persist a named fact in this Durable Object session.",
      parameters: Type.Object({
        key: Type.String({ minLength: 1, maxLength: 64 }),
        value: Type.String({ maxLength: 4000 })
      }),
      replay: "safe",
      async execute(args) {
        const input = argsOf<{ key: string; value: string }>(args);
        await storage.put(`${MEMORY_PREFIX}${input.key}`, input.value);
        return text(`Remembered ${JSON.stringify(input.key)}.`, {
          key: input.key
        });
      }
    },
    {
      name: "recall",
      description: "Read one fact previously saved in this session.",
      parameters: Type.Object({
        key: Type.String({ minLength: 1, maxLength: 64 })
      }),
      replay: "safe",
      async execute(args) {
        const { key } = argsOf<{ key: string }>(args);
        const value = await storage.get<string>(`${MEMORY_PREFIX}${key}`);
        return text(value ?? `No memory named ${JSON.stringify(key)}.`, {
          key,
          found: value !== undefined
        });
      }
    },
    {
      name: "list_memories",
      description: "List the fact names stored in this session.",
      parameters: Type.Object({}),
      replay: "safe",
      async execute() {
        const values = await storage.list<string>({ prefix: MEMORY_PREFIX });
        const keys = [...values.keys()].map((key) =>
          key.slice(MEMORY_PREFIX.length)
        );
        return text(keys.length === 0 ? "No memories." : keys.join("\n"), {
          keys
        });
      }
    },
    {
      name: "current_time",
      description: "Return the current UTC time.",
      parameters: Type.Object({}),
      replay: "safe",
      async execute() {
        const iso = new Date().toISOString();
        return text(iso, { iso });
      }
    }
  ];
}

const skills = fromManifest({
  id: "pi-playground-skills",
  fingerprint: "1",
  skills: [
    {
      name: "trip-planning",
      description:
        "Use when the user asks to plan a trip, itinerary, or travel schedule.",
      body: [
        "Ask for the destination, dates, and interests if not given.",
        "Use the calculator tool for any budget math instead of estimating.",
        "Remember the finished itinerary with the remember tool under the key",
        "`itinerary` so it can be recalled in a later message."
      ].join("\n")
    }
  ]
});

/** Playable pi session backed by one Durable Object. */
export class PiAgent extends DurableObject<Env> {
  readonly driver = new Driver();
  readonly harness = new PiHarness({
    driver: this.driver,
    models: createModels({ providers: [workersAI(this.env.AI)] }),
    model: { provider: "cloudflare-workers-ai", modelId: MODEL_ID },
    thinkingLevel: "low",
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 500 },
    tools: createTools(this.ctx.storage),
    skills: [skills],
    systemPrompt:
      "You are a concise playground assistant. Use tools whenever they can answer the request. Explain tool results plainly. You can calculate, roll dice, read the current time, and persist or recall facts for this session.",
    configure: (registry) => {
      registry.hooks.add(ToolTask, {
        beforeTool: (call) =>
          call.name === "remember" &&
          typeof call.arguments.key === "string" &&
          call.arguments.key.startsWith("_")
            ? { block: "Memory names cannot start with _." }
            : undefined
      });
    }
  });
  // App glue, not the harness: how this app puts sessions on a socket.
  readonly sockets = new PiSessionSockets(this.harness, (tag) =>
    this.ctx.getWebSockets(tag)
  );
  readonly webSockets = new WebSockets(this.sockets.options());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.driver)
    .use(this.webSockets)
    .use(this.harness);

  /** Host startup, after the harness has opened pi. */
  async onStart(): Promise<void> {
    await this.sockets.reattach();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/api/session") {
      // A fresh session id for the client to open its WebSocket against.
      return Response.json({ session: crypto.randomUUID() });
    }
    try {
      return (
        (await routeAgentRequest(request, env, { cors: true })) ??
        new Response("Not found", { status: 404 })
      );
    } catch (error) {
      console.error("Pi playground request failed", error);
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }
} satisfies ExportedHandler<Env>;
