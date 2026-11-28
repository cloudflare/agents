/**
 * The Pi harness suite's Worker: the Pi harness (`agents/harness/pi`) in a
 * Durable Object, on a scripted model for the fault cases (so a red is never
 * the model) or on Workers AI for the real conversation.
 *
 * Its tools: `gate` and `gate_unsafe` count their runs and wait until the
 * suite releases them (one replay-safe, one not); `multiply` multiplies by
 * three; `deadline` parks on a 40 s deadline.
 */
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type TranscriptContext
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { num, obj } from "@earendil-works/pi-schema";
import {
  createRegistry,
  Harness,
  type Extension,
  type ToolRegistration
} from "@earendil-works/pi-durable";
import { DurableObject } from "cloudflare:workers";
import { createInlineCodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { Browser, browserRun } from "agents/browser";
import { browserTool } from "agents/browser/pi";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import {
  probeWorker,
  REAL_MODEL,
  RELEASE_KEY,
  textOf,
  type BaseEnv
} from "./shared";

type Env = BaseEnv & {
  BROWSER: Fetcher;
  LOADER: WorkerLoader;
  PiProbe: DurableObjectNamespace<PiProbe>;
};

const NoParameters = obj({});
const MultiplyParameters = obj({ value: num() });

/** Model code for the browser tool: reads the active tab's title. */
const TITLE_CODE = `async () => {
  const r = await browser.cdp({ method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true }, sessionId: "active" });
  return { title: r.result.value };
}`;

/**
 * A codemode script: one multiply (journaled), then the gate. A reset while
 * it waits on the gate replays the script: the multiply's result comes from
 * the journal, the replay-safe gate runs again.
 */
const CODEMODE_SCRIPT = `const n = await tools.multiply({ value: 7 });
await tools.gate({});
return { n };`;

/** The faux model: a tool call for a prompt that names one, else an echo. */
function script(context: TranscriptContext): AssistantMessage {
  const messages = context.messages.filter((m) => m.role !== "system");
  const last = messages.at(-1);
  if (last?.role === "toolResult") {
    return fauxAssistantMessage([
      fauxText(
        `${last.isError ? "tool failed" : "tool said"}: ${textOf(last.content)}`
      )
    ]);
  }
  const prompt = last?.role === "user" ? textOf(last.content) : "";
  const call = (name: string, args: Record<string, string> = {}) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
  if (["gate", "gate_unsafe", "deadline"].includes(prompt)) return call(prompt);
  if (prompt === "codemode") return call("codemode", { code: CODEMODE_SCRIPT });
  if (prompt === "browser") return call("browser", { code: TITLE_CODE });
  return fauxAssistantMessage([fauxText(`echo: ${prompt}`)]);
}

export class PiProbe extends DurableObject<Env> {
  readonly #real = this.ctx.id.name?.startsWith("real-") ?? false;
  readonly #ai = createAI({ binding: this.env.AI });
  readonly #faux = fauxProvider({
    tokensPerSecond: 200,
    tokenSize: { min: 2, max: 4 }
  });
  readonly browser = new Browser({ provider: browserRun(this.env.BROWSER) });
  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      this.registry.install(this.#tools());
      this.registry.install({
        name: "browser",
        tools: [browserTool({ browser: this.browser, loader: this.env.LOADER })]
      });
      this.registry.install(
        createCodemodeExtension({
          models: false,
          sandbox: createInlineCodemodeSandbox()
        })
      );
      const models = createModels();
      models.setProvider(this.#real ? this.#ai.provider : this.#faux.provider);
      return Harness.open(
        storage,
        {
          models,
          registry: this.registry,
          onWake,
          onReport: (report) =>
            console.warn("pi report", report.kind, String(report.error))
        },
        context
      );
    },
    defaults: {
      model: this.#real ? this.#ai(REAL_MODEL) : this.#faux.getModel()
    }
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.browser)
    .use(this.harness);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#faux.setResponses(Array.from({ length: 500 }, () => script));
    void this.#witness("start");
  }

  #witness(key: string) {
    return this.env.Witness.getByName(this.ctx.id.name ?? "").bump(key);
  }

  #tools(): Extension {
    const storage = this.ctx.storage;
    const witness = (key: string) => this.#witness(key);
    const gate = (
      name: string,
      replay: "safe" | "unsafe"
    ): ToolRegistration<typeof NoParameters> => ({
      name,
      description: "Wait until the operator releases it.",
      parameters: NoParameters,
      replay,
      async execute(_args, _api, context) {
        const runs = await witness(name);
        while (!(await storage.get<boolean>(RELEASE_KEY))) {
          context.abortSignal?.throwIfAborted();
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return {
          output: [{ type: "text", text: `released after ${runs} runs` }]
        };
      }
    });
    const multiply: ToolRegistration<typeof MultiplyParameters> = {
      name: "multiply",
      description: "Multiply a number by three.",
      parameters: MultiplyParameters,
      replay: "safe",
      async execute({ value }) {
        await witness("multiply");
        return { output: [{ type: "text", text: String(value * 3) }] };
      }
    };
    // Parks the call with a deadline 40 s out, holding nothing: the object
    // may go idle, and pi's alarm brings it back to finish the call.
    const deadline: ToolRegistration<typeof NoParameters> = {
      name: "deadline",
      description: "Wait 40 seconds, then report.",
      parameters: NoParameters,
      replay: "safe",
      async execute(_args, api) {
        if (api.wake !== undefined) {
          await witness("deadline-woke");
          return {
            output: [{ type: "text", text: `woke ${api.wake.reason}` }]
          };
        }
        await witness("deadline-parked");
        return { kind: "sleep", until: api.now() + 40_000, signals: [] };
      }
    };
    return {
      name: "probe-tools",
      tools: [
        gate("gate", "safe"),
        gate("gate_unsafe", "unsafe"),
        multiply,
        deadline
      ]
    };
  }

  async probeSubmit(text: string) {
    return this.harness.submit(text);
  }
  async probeWait(operationId: string) {
    return this.harness.wait(operationId);
  }
  async probeRelease() {
    await this.ctx.storage.put(RELEASE_KEY, true);
  }
  async probeState() {
    return {
      pending: (await this.harness.pending()).length,
      alarm: await this.ctx.storage.getAlarm(),
      entries: (await this.harness.messages()).length
    };
  }
  async probeAlarm() {
    return this.ctx.storage.getAlarm();
  }
  async probeReset() {
    this.ctx.abort("probe: reset");
  }
}

export default probeWorker<Env>("pi", (env) => env.PiProbe);

export { Witness } from "./shared";
// The browser tool runs model code in a codemode runtime facet of this class.
export { CodemodeRuntime } from "agents/browser";
