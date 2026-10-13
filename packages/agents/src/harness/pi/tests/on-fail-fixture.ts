import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  type Message,
  type TranscriptContext
} from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../../../lifecycle";
import { setWakeTimingForTests } from "../harness";
import {
  PiHarness,
  type PiHarnessOptions,
  type PiOperationResult
} from "../index";
import { fauxModels, NO_RETRY } from "./faux";
import { TEST_TIMING } from "./timing";

const RELEASE_KEY = "test:fail:release";

function textOf(content: Message["content"] | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      "text" in part && typeof part.text === "string" ? part.text : ""
    )
    .join("");
}

function defineOnFailTestObject(onFail?: PiHarnessOptions["onFail"]) {
  return class extends DurableObject<Cloudflare.Env> {
    readonly #faux = fauxProvider({
      tokensPerSecond: 200,
      tokenSize: { min: 2, max: 4 }
    });
    readonly harness = new PiHarness({
      harness: async ({ storage, context }) =>
        Harness.open(
          storage,
          {
            models: fauxModels(this.#faux.provider),
            registry: createRegistry(),
            settings: { retry: NO_RETRY }
          },
          context
        ),
      defaults: { model: this.#faux.getModel() },
      ...(onFail === undefined ? {} : { onFail })
    });
    readonly lifecycle = Lifecycle.install(this).use(this.harness);

    constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
      super(ctx, env);
      setWakeTimingForTests(this.harness, TEST_TIMING);
      // `fail` waits for the test's release, then fails for good; anything
      // else is echoed.
      const script = async (context: TranscriptContext) => {
        const last = context.messages
          .filter((message) => message.role === "user")
          .at(-1);
        const prompt = textOf(last?.content);
        if (prompt !== "fail") {
          return fauxAssistantMessage([fauxText(`echo: ${prompt}`)]);
        }
        while (!(await this.ctx.storage.get<boolean>(RELEASE_KEY))) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return fauxAssistantMessage([], {
          stopReason: "error",
          errorMessage: "Invalid request"
        });
      };
      this.#faux.setResponses(Array.from({ length: 20 }, () => script));
    }

    submit(text: string) {
      return this.harness.submit(text);
    }

    async release(): Promise<void> {
      await this.ctx.storage.put(RELEASE_KEY, true);
    }

    /** The operation's result, or `"pending"` if it has not settled in time. */
    async settledWithin(
      operationId: string,
      ms: number
    ): Promise<PiOperationResult | "pending"> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ms);
      try {
        return await this.harness.wait(operationId, {
          signal: controller.signal
        });
      } catch {
        return "pending";
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

export const PiOnFailResumeTestObject = defineOnFailTestObject();
export type PiOnFailResumeTestObject = InstanceType<
  typeof PiOnFailResumeTestObject
>;

export const PiOnFailAbortTestObject = defineOnFailTestObject("abort");
export type PiOnFailAbortTestObject = InstanceType<
  typeof PiOnFailAbortTestObject
>;
