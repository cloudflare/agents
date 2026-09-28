import { DurableObject } from "cloudflare:workers";
import { tool, type ToolSet, type UIMessage, type UIMessageChunk } from "ai";
import { z } from "zod";
import { Driver } from "../../driver";
import {
  ThinkHarness,
  type ThinkToolRecovery,
  type ThinkTurnEnd
} from "../../harness/think";
import { Lifecycle } from "../../lifecycle";
import { Sessions } from "../../sessions";
import { scriptedModel, type ModelTurn } from "../harness/think/scripted-model";

/** A turn end as plain JSON, so it crosses RPC with its types. */
type TurnEndView = {
  readonly turnId: string;
  readonly chat: string;
  readonly status: ThinkTurnEnd["status"];
  readonly text: string;
  readonly error?: string;
};

/** A transcript message as plain JSON. */
export type MessageView = {
  readonly id: string;
  readonly role: string;
  readonly parts: Array<{
    readonly type: string;
    readonly text?: string;
    readonly toolCallId?: string;
    readonly state?: string;
    readonly output?: string | number | boolean | null | object;
    readonly errorText?: string;
  }>;
};

/**
 * A Durable Object with Sessions, a Driver and a ThinkHarness, a scripted
 * model, and a few tools that record when they run.
 */
export class ThinkHarnessObject extends DurableObject<Cloudflare.Env> {
  readonly #script: ModelTurn[] = [];
  readonly #prompts: unknown[][] = [];
  readonly #chunks = new Map<string, UIMessageChunk[]>();
  readonly #ends: TurnEndView[] = [];
  #gate: { promise: Promise<void>; open: () => void } | undefined;

  readonly sessions = new Sessions();
  readonly driver = new Driver();
  readonly harness = new ThinkHarness({
    driver: this.driver,
    session: (chat) => this.sessions.session(chat),
    model: () => scriptedModel(this.#script, this.#prompts),
    system: () => "You are a test agent.",
    tools: () => this.#tools(),
    hooks: {
      onChunk: ({ turnId, chunk }) => {
        const chunks = this.#chunks.get(turnId) ?? [];
        chunks.push(chunk);
        this.#chunks.set(turnId, chunks);
      },
      onTurnEnd: (end) => {
        this.#ends.push(view(end));
      }
    }
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.sessions)
    .use(this.driver)
    .use(this.harness);

  #tools(): ToolSet {
    const record = async (name: string) => {
      const runs = (await this.ctx.storage.get<number>(`runs:${name}`)) ?? 0;
      await this.ctx.storage.put(`runs:${name}`, runs + 1);
    };
    const withRecovery = <T extends object>(
      definition: T,
      recovery: ThinkToolRecovery
    ) => Object.assign(definition, { recovery });
    return {
      add: tool({
        description: "Add two numbers",
        inputSchema: z.object({ a: z.number(), b: z.number() }),
        execute: async ({ a, b }) => {
          await record("add");
          return { sum: a + b };
        }
      }),
      deploy: tool({
        description: "Deploy the app",
        inputSchema: z.object({ env: z.string() }),
        needsApproval: true,
        execute: async ({ env }) => {
          await record("deploy");
          return { deployed: env };
        }
      }),
      slow: withRecovery(
        tool({
          description: "Hold until the test opens the gate",
          inputSchema: z.object({}),
          execute: async (_input, { abortSignal }) => {
            await record("slow");
            await held(this.#gate?.promise, abortSignal);
            return "slow done";
          }
        }),
        "never"
      ),
      read: withRecovery(
        tool({
          description: "Read something, safe to repeat",
          inputSchema: z.object({}),
          execute: async (_input, { abortSignal }) => {
            await record("read");
            await held(this.#gate?.promise, abortSignal);
            return "read done";
          }
        }),
        "safe"
      ),
      pickColor: tool({
        description: "Ask the client to pick a color",
        inputSchema: z.object({})
      }),
      fail: tool({
        description: "Always throws",
        inputSchema: z.object({}),
        execute: async (): Promise<string> => {
          throw new Error("tool exploded");
        }
      })
    };
  }

  // ── RPC for tests ────────────────────────────────────────────────

  script(...turns: ModelTurn[]): void {
    this.#script.push(...turns);
  }

  holdTools(): void {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    this.#gate = { promise, open };
  }

  releaseTools(): void {
    this.#gate?.open();
    this.#gate = undefined;
  }

  async send(text: string, turnId?: string, chat = "main") {
    const message: UIMessage = {
      id: `user-${turnId ?? crypto.randomUUID()}`,
      role: "user",
      parts: [{ type: "text", text }]
    };
    return this.harness.submit(chat, { messages: [message] }, { turnId });
  }

  async wait(turnId: string): Promise<TurnEndView> {
    return view(await this.harness.waitForTurn(turnId));
  }

  answer(toolCallId: string, approved: boolean, chat = "main") {
    return this.harness.answer(chat, toolCallId, { approved });
  }

  resolveTool(toolCallId: string, output: unknown, chat = "main") {
    return this.harness.resolveTool(chat, toolCallId, { ok: true, output });
  }

  stop(turnId: string) {
    return this.harness.stop(turnId);
  }

  turn(turnId: string) {
    return this.harness.turn(turnId);
  }

  async messages(chat = "main"): Promise<MessageView[]> {
    return (await this.sessions
      .session(chat)
      .getHistory()) as unknown as MessageView[];
  }

  chunks(turnId: string): string[] {
    return (this.#chunks.get(turnId) ?? []).map((chunk) => chunk.type);
  }

  ends(): TurnEndView[] {
    return this.#ends;
  }

  prompts(): string[] {
    return this.#prompts.map((prompt) => JSON.stringify(prompt));
  }

  toolRuns(name: string) {
    return this.ctx.storage.get<number>(`runs:${name}`);
  }
}

/** Wait for the gate, or throw once the call is aborted. */
async function held(
  gate: Promise<void> | undefined,
  signal: AbortSignal | undefined
): Promise<void> {
  if (!gate) return;
  await Promise.race([
    gate,
    new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true
      });
    })
  ]);
}

function view(end: ThinkTurnEnd): TurnEndView {
  return {
    turnId: end.turnId,
    chat: end.chat,
    status: end.status,
    text: (end.message?.parts ?? [])
      .map((part) => (part.type === "text" ? part.text : ""))
      .join(""),
    ...(end.error !== undefined ? { error: end.error } : {})
  };
}
