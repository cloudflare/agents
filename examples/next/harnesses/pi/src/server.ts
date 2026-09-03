import { DurableObject } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { Type } from "typebox";
import { PiHarness } from "./harness/pi-harness";
import type { PiEvent, PiTool } from "./harness/types";
import { Lifecycle } from "agents/lifecycle";
import { createModels } from "./providers/models";
import { workersAI } from "./providers/workers-ai";
import { fromManifest } from "agents/skills";
import { Streams } from "agents/streams";
import { Tasks } from "agents/tasks";
import { WebSockets } from "agents/websockets";

const MEMORY_PREFIX = "pi-playground:memory:";
const MODEL_ID = "@cf/moonshotai/kimi-k2.7-code";

const calculateParameters = Type.Object({
  operation: Type.Union([
    Type.Literal("add"),
    Type.Literal("subtract"),
    Type.Literal("multiply"),
    Type.Literal("divide"),
    Type.Literal("+"),
    Type.Literal("-"),
    Type.Literal("*"),
    Type.Literal("/")
  ]),
  left: Type.Number(),
  right: Type.Number()
});
const diceParameters = Type.Object({
  sides: Type.Integer({ minimum: 2, maximum: 1000 }),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 }))
});
const memoryParameters = Type.Object({
  key: Type.String({ minLength: 1, maxLength: 64 }),
  value: Type.String({ maxLength: 4000 })
});
const recallParameters = Type.Object({
  key: Type.String({ minLength: 1, maxLength: 64 })
});
const noParameters = Type.Object({});

type ToolContext = {
  readonly storage: DurableObjectStorage;
  readonly now: () => Date;
};

function text(content: string) {
  return [{ type: "text" as const, text: content }];
}

function calculate(
  operation: "add" | "subtract" | "multiply" | "divide" | "+" | "-" | "*" | "/",
  left: number,
  right: number
): number {
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

function createTools(): PiTool<ToolContext>[] {
  const calculator: PiTool<
    ToolContext,
    typeof calculateParameters,
    { readonly result: number }
  > = {
    name: "calculate",
    label: "Calculator",
    description: "Perform exact arithmetic with two numbers.",
    parameters: calculateParameters,
    replay: "safe",
    async execute(_id, input) {
      const result = calculate(input.operation, input.left, input.right);
      return { content: text(String(result)), details: { result } };
    }
  };

  const rollDice: PiTool<
    ToolContext,
    typeof diceParameters,
    { readonly rolls: number[]; readonly total: number }
  > = {
    name: "roll_dice",
    label: "Roll dice",
    description: "Roll one or more fair dice.",
    parameters: diceParameters,
    replay: "never",
    async execute(_id, input, onUpdate) {
      const count = input.count ?? 1;
      onUpdate({
        content: text(`Rolling ${count}d${input.sides}…`),
        details: { rolls: [], total: 0 }
      });
      const rolls = Array.from(
        { length: count },
        () => Math.floor(Math.random() * input.sides) + 1
      );
      const total = rolls.reduce((sum, roll) => sum + roll, 0);
      return {
        content: text(`Rolled ${rolls.join(", ")} (total ${total})`),
        details: { rolls, total }
      };
    }
  };

  const remember: PiTool<
    ToolContext,
    typeof memoryParameters,
    { readonly key: string }
  > = {
    name: "remember",
    label: "Remember",
    description: "Persist a named fact in this Durable Object session.",
    parameters: memoryParameters,
    replay: "safe",
    async execute(_id, input, _onUpdate, context) {
      await context.storage.put(`${MEMORY_PREFIX}${input.key}`, input.value);
      return {
        content: text(`Remembered ${JSON.stringify(input.key)}.`),
        details: { key: input.key }
      };
    }
  };

  const recall: PiTool<
    ToolContext,
    typeof recallParameters,
    { readonly key: string; readonly found: boolean }
  > = {
    name: "recall",
    label: "Recall",
    description: "Read one fact previously saved in this session.",
    parameters: recallParameters,
    replay: "safe",
    async execute(_id, input, _onUpdate, context) {
      const value = await context.storage.get<string>(
        `${MEMORY_PREFIX}${input.key}`
      );
      return {
        content: text(
          value === undefined
            ? `No memory named ${JSON.stringify(input.key)}.`
            : value
        ),
        details: { key: input.key, found: value !== undefined }
      };
    }
  };

  const listMemory: PiTool<
    ToolContext,
    typeof noParameters,
    { readonly keys: string[] }
  > = {
    name: "list_memories",
    label: "List memories",
    description: "List the fact names stored in this session.",
    parameters: noParameters,
    replay: "safe",
    async execute(_id, _input, _onUpdate, context) {
      const values = await context.storage.list<string>({
        prefix: MEMORY_PREFIX
      });
      const keys = [...values.keys()].map((key) =>
        key.slice(MEMORY_PREFIX.length)
      );
      return {
        content: text(keys.length === 0 ? "No memories." : keys.join("\n")),
        details: { keys }
      };
    }
  };

  const clock: PiTool<
    ToolContext,
    typeof noParameters,
    { readonly iso: string }
  > = {
    name: "current_time",
    label: "Current time",
    description: "Return the current UTC time.",
    parameters: noParameters,
    replay: "safe",
    async execute(_id, _input, _onUpdate, context) {
      const iso = context.now().toISOString();
      return { content: text(iso), details: { iso } };
    }
  };

  return [calculator, rollDice, remember, recall, listMemory, clock];
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
  readonly tasks = new Tasks();
  readonly streams = new Streams();
  readonly harness = new PiHarness<ToolContext>({
    models: createModels({ providers: [workersAI(this.env.AI)] }),
    model: { provider: "cloudflare-workers-ai", modelId: MODEL_ID },
    tasks: this.tasks,
    streams: this.streams,
    thinkingLevel: "low",
    toolContext: { storage: this.ctx.storage, now: () => new Date() },
    tools: () => createTools(),
    skills: [skills],
    systemPrompt:
      "You are a concise playground assistant. Use tools whenever they can answer the request. Explain tool results plainly. You can calculate, roll dice, read the current time, and persist or recall facts for this session.",
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 500 },
    compaction: {
      enabled: true,
      reserveTokens: 4000,
      keepRecentTokens: 12000
    },
    configure: (hooks) => {
      hooks.on("before_tool", (event) => {
        if (
          typeof event === "object" &&
          event !== null &&
          "toolName" in event &&
          event.toolName === "remember" &&
          "args" in event &&
          typeof event.args === "object" &&
          event.args !== null &&
          "key" in event.args &&
          typeof event.args.key === "string" &&
          event.args.key.startsWith("_")
        ) {
          return { block: { reason: "Memory names cannot start with _." } };
        }
        return undefined;
      });
    }
  });

  readonly webSockets = new WebSockets(this.harness.webSockets());

  readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.webSockets)
    .use(this.harness);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Surface durable operation lifecycle in the tail log for local `wrangler
    // dev` observability; a real host would forward these to its own sink.
    this.harness.on((event: PiEvent) => {
      if (event.type === "fault" || event.type === "operation_end") {
        console.log("pi", event);
      }
    });
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
