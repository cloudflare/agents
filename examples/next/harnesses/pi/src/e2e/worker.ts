/**
 * The Worker the deployed e2e suite (`e2e/deployed.test.ts`) deploys: the
 * example's `PiHarness` on Workers AI, with the playground's `sleep` and
 * `current_time` plus two tools from `agents/tools/testing` that kill the
 * Durable Object mid-turn:
 *
 * - `oom` fills memory until the isolate exceeds its 128 MB limit.
 * - `burn_cpu` fetches an endless byte stream from this Worker's own
 *   `/bytes` route and hashes it until the invocation exceeds its CPU limit.
 *
 * The suite must not wake the object it is testing: any request would start
 * a new instance and resume pi, hiding whether the harness's wake alarm
 * recovers on its own. So each `PiChaosAgent` reports its progress (model
 * streaming, tool starts) and outcome to a separate `ChaosResults` object,
 * and the suite polls that. The only request the suite sends an agent after
 * submitting is `kill`, which resets it the way a runtime restart does.
 *
 * Neither limit is enforced by local workerd, so this Worker only means
 * anything deployed. Every route requires the `x-e2e-token` header to match
 * the `E2E_TOKEN` var the suite sets at deploy time, so the chaos endpoints
 * are not open while the throwaway Worker exists.
 */
import { DurableObject } from "cloudflare:workers";
import { Type } from "@earendil-works/pi-ai";
import type {
  AgentEvent,
  ToolExecutionResult,
  ToolRegistration
} from "@earendil-works/pi-durable";
import { Lifecycle } from "agents/lifecycle";
import {
  burnCpu,
  fillMemory,
  generateBytes,
  type CrashTool
} from "agents/tools/testing";
import { PiHarness } from "../harness/pi-harness";
import { createModels } from "../providers/models";
import { workersAI } from "../providers/workers-ai";
import { createTools, MODEL_ID, text } from "../tools";
import { TOKEN_HEADER, type ChaosProgress, type ChaosStatus } from "./protocol";

/** Bindings from `src/e2e/wrangler.jsonc`, plus the deploy-time token. */
export interface ChaosEnv {
  AI: Ai;
  PiChaosAgent: DurableObjectNamespace<PiChaosAgent>;
  ChaosResults: DurableObjectNamespace<ChaosResults>;
  /** Shared secret every route requires, set with `wrangler deploy --var`. */
  E2E_TOKEN?: string;
}

const INSTANCES_KEY = "e2e:instances";
const OPERATION_KEY = "e2e:operation";
const RESULT_KEY = "e2e:result";
const PROGRESS_KEY = "e2e:progress";

function crashedKey(tool: CrashTool): string {
  return `e2e:crashed:${tool}`;
}

/** One pi session under test, backed by its own Durable Object. */
export class PiChaosAgent extends DurableObject<ChaosEnv> {
  readonly harness = new PiHarness({
    models: createModels({ providers: [workersAI(this.env.AI)] }),
    model: { provider: "cloudflare-workers-ai", modelId: MODEL_ID },
    thinkingLevel: "low",
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 500 },
    tools: [...createTools(), this.#oomTool(), this.#burnCpuTool()],
    systemPrompt:
      "You are an agent under a durability test. Follow the user's numbered steps exactly and in order, calling the tools they name."
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);
  #reporting = false;
  #watching = false;

  constructor(ctx: DurableObjectState, env: ChaosEnv) {
    super(ctx, env);
    // Count instances, not Lifecycle starts: an instance that only serves
    // RPC never runs Lifecycle startup.
    void ctx.blockConcurrencyWhile(async () => {
      const instances = (await ctx.storage.get<number>(INSTANCES_KEY)) ?? 0;
      await ctx.storage.put(INSTANCES_KEY, instances + 1);
    });
  }

  /** Host startup: after a crash, the wake alarm lands here. */
  async onStart(): Promise<void> {
    const operationId = await this.ctx.storage.get<string>(OPERATION_KEY);
    if (operationId === undefined) return;
    this.#watch();
    this.#report(operationId);
  }

  /**
   * Durably submit a prompt to the root session and report when it settles.
   * Submitting the same operation id again is a no-op.
   */
  async submit(prompt: string, operationId: string): Promise<void> {
    // Native RPC bypasses the fetch entry point that starts Lifecycle.
    await this.lifecycle.start();
    this.#watch();
    await this.harness.submit(prompt, { operationId });
    await this.ctx.storage.put(OPERATION_KEY, operationId);
    this.#report(operationId);
  }

  /**
   * Reset the object the way a runtime restart does: in-memory state and
   * timers are dropped and nothing drains. The wake alarm must bring it back.
   */
  kill(): void {
    this.ctx.abort("e2e: simulated runtime reset");
  }

  /**
   * The current status, read from this object. Waking it resumes pi, so the
   * suite only calls this for diagnostics after a scenario failed.
   */
  async status(): Promise<string> {
    const operationId = await this.ctx.storage.get<string>(OPERATION_KEY);
    const pending =
      operationId === undefined ||
      (await this.harness.pending()).some(
        (operation) => operation.operationId === operationId
      );
    return JSON.stringify(
      await this.#status(
        pending || operationId === undefined
          ? { status: "pending" }
          : await this.harness.wait(operationId)
      )
    );
  }

  /** Wait for the operation in the background and hand its outcome over. */
  #report(operationId: string): void {
    if (this.#reporting) return;
    this.#reporting = true;
    void (async () => {
      if (await this.ctx.storage.get<boolean>(RESULT_KEY)) return;
      const operation = await this.harness.wait(operationId);
      const status = await this.#status(operation);
      const name = this.ctx.id.name ?? this.ctx.id.toString();
      await this.env.ChaosResults.getByName(name).put(JSON.stringify(status));
      await this.ctx.storage.put(RESULT_KEY, true);
    })()
      .catch((error: unknown) => console.error("e2e report failed", error))
      .finally(() => {
        this.#reporting = false;
      });
  }

  /** Forward model streaming and tool starts to `ChaosResults`. */
  #watch(): void {
    if (this.#watching) return;
    this.#watching = true;
    const results = this.env.ChaosResults.getByName(
      this.ctx.id.name ?? this.ctx.id.toString()
    );
    const instance = crypto.randomUUID().slice(0, 8);
    void (async () => {
      const stream = await this.harness.session().events();
      let streaming = false;
      stream.start(async (events: readonly AgentEvent[]) => {
        for (const event of events) {
          let label: string | undefined;
          if (event.type === "message_start") streaming = false;
          if (event.type === "message_update" && !streaming) {
            streaming = true;
            label = "generating";
          }
          if (event.type === "tool_execution_start") {
            label = `tool:${event.toolName}`;
          }
          if (label !== undefined) {
            await results.progress({ label, instance, at: Date.now() });
          }
        }
      });
    })().catch((error: unknown) => {
      this.#watching = false;
      console.error("e2e watch failed", error);
    });
  }

  async #status(operation: ChaosStatus["operation"]): Promise<ChaosStatus> {
    return {
      instances: (await this.ctx.storage.get<number>(INSTANCES_KEY)) ?? 0,
      operation,
      messages: await this.harness.messages()
    };
  }

  /**
   * Run a crash tool's body at most once per object. pi never reruns an
   * interrupted `unsafe` tool, but the model could call it again after the
   * restart, and each memory-limit crash is a strike toward sealing the
   * object's recovery jobs. The marker is synced to disk before the crash so
   * it survives it.
   */
  async #once(
    tool: CrashTool,
    run: () => Promise<ToolExecutionResult>
  ): Promise<ToolExecutionResult> {
    const key = crashedKey(tool);
    if (await this.ctx.storage.get<boolean>(key)) {
      return {
        ...text(
          `${tool} already crashed this server once. Do not call it again.`
        ),
        isError: true
      };
    }
    await this.ctx.storage.put(key, true);
    await this.ctx.storage.sync();
    return run();
  }

  #oomTool(): ToolRegistration {
    return {
      name: "oom",
      description:
        "Testing tool. Crashes the server by filling memory until the runtime kills it for exceeding its memory limit. It does not return.",
      parameters: Type.Object({}),
      replay: "unsafe",
      execute: (_args, _api, context) =>
        this.#once("oom", () => fillMemory(context.abortSignal))
    };
  }

  #burnCpuTool(): ToolRegistration {
    return {
      name: "burn_cpu",
      description:
        "Testing tool. Crashes the server by downloading an endless byte stream and hashing it until the runtime stops it for exceeding its CPU limit. It does not return.",
      parameters: Type.Object({}),
      replay: "unsafe",
      execute: (_args, _api, context) =>
        this.#once("burn_cpu", async () => {
          // ctx.exports.default is this Worker's own fetch handler. Its type
          // comes from the playground's main module, which also has one.
          const response = await this.ctx.exports.default.fetch(
            "https://pi-harness-e2e/bytes",
            { headers: { [TOKEN_HEADER]: this.env.E2E_TOKEN ?? "" } }
          );
          const { bytes } = await burnCpu(response, context.abortSignal);
          return text(`Hashed ${bytes} bytes and the stream ended.`);
        })
    };
  }
}

/**
 * Where each `PiChaosAgent` of the same name reports its outcome, so the
 * suite can poll without waking the agent.
 */
export class ChaosResults extends DurableObject<ChaosEnv> {
  /** Store the agent's final status. */
  async put(status: string): Promise<void> {
    await this.ctx.storage.put(RESULT_KEY, status);
  }

  /** The agent's final status, or `null` until it reports. */
  async get(): Promise<string | null> {
    return (await this.ctx.storage.get<string>(RESULT_KEY)) ?? null;
  }

  /** Record one progress event. */
  async progress(event: ChaosProgress): Promise<void> {
    const events =
      (await this.ctx.storage.get<ChaosProgress[]>(PROGRESS_KEY)) ?? [];
    await this.ctx.storage.put(PROGRESS_KEY, [...events, event]);
  }

  /** Every progress event so far, as JSON. */
  async getProgress(): Promise<string> {
    return JSON.stringify(
      (await this.ctx.storage.get<ChaosProgress[]>(PROGRESS_KEY)) ?? []
    );
  }
}

const AGENT_ROUTE = /^\/e2e\/([\w-]+)\/(submit|result|progress|status|kill)$/;

function json(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "application/json" }
  });
}

export default {
  async fetch(request: Request, env: ChaosEnv): Promise<Response> {
    const token = request.headers.get(TOKEN_HEADER);
    if (!env.E2E_TOKEN || token !== env.E2E_TOKEN) {
      return new Response("Forbidden", { status: 403 });
    }
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/bytes") return generateBytes();

    const route = AGENT_ROUTE.exec(url.pathname);
    if (!route) return new Response("Not found", { status: 404 });
    const [, name = "", action] = route;
    switch (action) {
      case "submit": {
        if (request.method !== "POST") break;
        const { prompt, operationId } = await request.json<{
          prompt: string;
          operationId: string;
        }>();
        await env.PiChaosAgent.getByName(name).submit(prompt, operationId);
        return new Response(null, { status: 202 });
      }
      case "result":
        return json((await env.ChaosResults.getByName(name).get()) ?? "null");
      case "progress":
        return json(await env.ChaosResults.getByName(name).getProgress());
      case "status":
        return json(await env.PiChaosAgent.getByName(name).status());
      case "kill": {
        if (request.method !== "POST") break;
        // The reset rejects the call that caused it.
        const error = await env.PiChaosAgent.getByName(name)
          .kill()
          .then(
            () => undefined,
            (reason: unknown) => String(reason)
          );
        return Response.json({ killed: true, error });
      }
    }
    return new Response("Bad request", { status: 400 });
  }
} satisfies ExportedHandler<ChaosEnv>;
