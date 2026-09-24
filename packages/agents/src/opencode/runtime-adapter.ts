import type {
  HarnessDriverCancellation,
  HarnessDriverDriveResult,
  HarnessDriverInspection,
  HarnessDriverRuntime
} from "../driver";
import type { OpenCodeRequest, OpenCodeResult } from "./types";

type OpenCodeMessage = {
  readonly info: {
    readonly id: string;
    readonly role: string;
    readonly time?: { readonly completed?: number };
    readonly error?: { readonly type?: string; readonly message?: string };
  };
};

export interface OpenCodeRuntimeClient {
  listMessages(sessionId: string): Promise<unknown>;
  prompt(input: {
    readonly sessionID: string;
    readonly id: string;
    readonly text: string;
  }): Promise<unknown>;
  switchAgent(input: {
    readonly sessionID: string;
    readonly agent: string;
  }): Promise<unknown>;
  wait(sessionId: string, signal: AbortSignal): Promise<void>;
  interrupt(sessionId: string): Promise<unknown>;
}

export type OpenCodeRuntimeAdapterOptions = {
  readonly client: OpenCodeRuntimeClient;
  readonly passBudgetMs?: number;
  readonly heartbeatMs?: number;
  readonly defaultAgent?: string;
  readonly afterAdmit?: (
    scope: string,
    operationId: string
  ) => void | Promise<void>;
  readonly beforeDrive?: (
    scope: string,
    operationId: string
  ) => void | Promise<void>;
};

export class OpenCodeRuntimeAdapter implements HarnessDriverRuntime<
  OpenCodeRequest,
  OpenCodeResult
> {
  readonly #client: OpenCodeRuntimeClient;
  readonly #passBudgetMs: number;
  readonly #heartbeatMs: number;
  readonly #defaultAgent: string | undefined;
  readonly #afterAdmit: OpenCodeRuntimeAdapterOptions["afterAdmit"];
  readonly #beforeDrive: OpenCodeRuntimeAdapterOptions["beforeDrive"];

  constructor(options: OpenCodeRuntimeAdapterOptions) {
    this.#client = options.client;
    this.#passBudgetMs = options.passBudgetMs ?? 20_000;
    this.#heartbeatMs = options.heartbeatMs ?? 30_000;
    this.#defaultAgent = options.defaultAgent;
    this.#afterAdmit = options.afterAdmit;
    this.#beforeDrive = options.beforeDrive;
  }

  async inspect(
    scope: string,
    operationId: string
  ): Promise<HarnessDriverInspection<OpenCodeResult>> {
    const messages = this.#messages(await this.#client.listMessages(scope));
    const index = messages.findIndex(
      (message) => message.info.id === this.#messageId(operationId)
    );
    if (index < 0) return { status: "not-admitted" };
    const nextUser = messages.findIndex(
      (message, messageIndex) =>
        messageIndex > index && message.info.role === "user"
    );
    const boundary = nextUser < 0 ? messages.length : nextUser;
    const assistant = messages
      .slice(index + 1, boundary)
      .find((message) => message.info.role === "assistant");
    if (!assistant?.info.time?.completed) return { status: "active" };
    const error = assistant.info.error;
    if (error) {
      return {
        status: "completed",
        result: {
          operationId,
          status: "failed",
          messageId: assistant.info.id,
          error: {
            code: error.type ?? "error",
            message: error.message ?? "OpenCode execution failed"
          }
        }
      };
    }
    return {
      status: "completed",
      result: {
        operationId,
        status: "completed",
        messageId: assistant.info.id
      }
    };
  }

  async admit(
    scope: string,
    operationId: string,
    input: OpenCodeRequest
  ): Promise<void> {
    const agent = input.agent ?? this.#defaultAgent;
    if (agent) await this.#client.switchAgent({ sessionID: scope, agent });
    await this.#client.prompt({
      sessionID: scope,
      id: this.#messageId(operationId),
      text: input.text
    });
    await this.#afterAdmit?.(scope, operationId);
  }

  async drive(
    scope: string,
    operationId: string,
    signal: AbortSignal
  ): Promise<HarnessDriverDriveResult<OpenCodeResult>> {
    await this.#beforeDrive?.(scope, operationId);
    const completed = await this.inspect(scope, operationId);
    if (completed.status === "completed") {
      return { status: "completed", result: completed.result };
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const waited = this.#client.wait(scope, controller.signal);
      const budget = new Promise<"budget">((resolve) => {
        timer = setTimeout(() => resolve("budget"), this.#passBudgetMs);
      });
      const outcome = await Promise.race([
        waited.then(() => "idle" as const),
        budget
      ]);
      if (outcome === "idle") {
        const settled = await this.inspect(scope, operationId);
        if (settled.status === "completed") {
          return { status: "completed", result: settled.result };
        }
      }
      return {
        status: "waiting",
        notBefore: Date.now() + this.#heartbeatMs
      };
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      signal.removeEventListener("abort", abort);
    }
  }

  async cancel(
    scope: string,
    operationId: string
  ): Promise<HarnessDriverCancellation<OpenCodeResult>> {
    const inspection = await this.inspect(scope, operationId);
    if (inspection.status === "completed") {
      return { status: "completed" as const, result: inspection.result };
    }
    if (inspection.status === "not-admitted") {
      return { status: "not-found" as const };
    }
    const response = await this.#client.interrupt(scope);
    if (
      typeof response === "object" &&
      response !== null &&
      "interrupted" in response &&
      response.interrupted === true
    ) {
      return { status: "cancelled" as const };
    }
    return {
      status: "pending" as const,
      notBefore: Date.now() + this.#heartbeatMs
    };
  }

  #messageId(operationId: string): string {
    return `msg_${operationId}`;
  }

  #messages(value: unknown): readonly OpenCodeMessage[] {
    if (Array.isArray(value)) return value as OpenCodeMessage[];
    if (
      typeof value === "object" &&
      value !== null &&
      "messages" in value &&
      Array.isArray(value.messages)
    ) {
      return value.messages as OpenCodeMessage[];
    }
    return [];
  }
}
