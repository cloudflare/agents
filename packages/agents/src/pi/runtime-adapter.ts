import {
  BACKGROUND_CONTEXT,
  type AgentLane,
  type Context
} from "@earendil-works/pi-agent-core";
import type {
  HarnessDriverCancellation,
  HarnessDriverDriveResult,
  HarnessDriverInspection,
  HarnessDriverRuntime
} from "../driver";
import { asUpstreamRequest, projectResult } from "./adapters";
import type { PiOperationRequest, PiOperationResult } from "./types";

export type PiDriverLane = Pick<
  AgentLane,
  "getResult" | "inspectExecution" | "accept" | "drive" | "requestAbort"
>;

export type PiRuntimeAdapterOptions = {
  readonly lane: (name: string, context: Context) => Promise<PiDriverLane>;
  readonly beforeDrive?: (
    scope: string,
    operationId: string,
    lane: PiDriverLane
  ) => void | Promise<void>;
  readonly deferredPollMs?: number;
  readonly laneBusyPollMs?: number;
};

export class PiRuntimeAdapter implements HarnessDriverRuntime<
  PiOperationRequest,
  PiOperationResult
> {
  readonly #lane: PiRuntimeAdapterOptions["lane"];
  readonly #beforeDrive: PiRuntimeAdapterOptions["beforeDrive"];
  readonly #deferredPollMs: number;
  readonly #laneBusyPollMs: number;

  constructor(options: PiRuntimeAdapterOptions) {
    this.#lane = options.lane;
    this.#beforeDrive = options.beforeDrive;
    this.#deferredPollMs = options.deferredPollMs ?? 30_000;
    this.#laneBusyPollMs = options.laneBusyPollMs ?? 250;
  }

  async inspect(
    scope: string,
    operationId: string
  ): Promise<HarnessDriverInspection<PiOperationResult>> {
    const lane = await this.#lane(scope, BACKGROUND_CONTEXT);
    const result = await lane.getResult(operationId, BACKGROUND_CONTEXT);
    if (result)
      return { status: "completed" as const, result: projectResult(result) };
    const execution = await lane.inspectExecution(BACKGROUND_CONTEXT);
    if (execution.current?.id === operationId)
      return { status: "active" as const };
    if (execution.current) {
      return {
        status: "waiting" as const,
        notBefore: Date.now() + this.#laneBusyPollMs
      };
    }
    return { status: "not-admitted" as const };
  }

  async admit(
    scope: string,
    operationId: string,
    input: PiOperationRequest
  ): Promise<void> {
    const lane = await this.#lane(scope, BACKGROUND_CONTEXT);
    const admitted = await lane.accept(
      asUpstreamRequest(input, operationId),
      BACKGROUND_CONTEXT
    );
    if (!admitted.ok) throw admitted.error;
  }

  async drive(
    scope: string,
    operationId: string,
    signal: AbortSignal
  ): Promise<HarnessDriverDriveResult<PiOperationResult>> {
    const lane = await this.#lane(scope, BACKGROUND_CONTEXT);
    await this.#beforeDrive?.(scope, operationId, lane);
    const onAbort = () => {
      void lane.requestAbort(operationId, BACKGROUND_CONTEXT);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const driven = await lane.drive(
        { operationId, waitForRetry: false, pollDeferred: true },
        BACKGROUND_CONTEXT
      );
      if (!driven.ok) throw driven.error;
      if (driven.value.kind === "settled") {
        return {
          status: "completed" as const,
          result: projectResult(driven.value.outcome)
        };
      }
      if (driven.value.reason === "retry") {
        return {
          status: "waiting" as const,
          notBefore: driven.value.notBefore
        };
      }
      return {
        status: "waiting" as const,
        notBefore:
          Date.now() +
          (driven.value.deferred.pollAfterMs ?? this.#deferredPollMs)
      };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async cancel(
    scope: string,
    operationId: string
  ): Promise<HarnessDriverCancellation<PiOperationResult>> {
    const lane = await this.#lane(scope, BACKGROUND_CONTEXT);
    const result = await lane.getResult(operationId, BACKGROUND_CONTEXT);
    if (result) {
      return {
        status: "completed" as const,
        result: projectResult(result)
      };
    }
    const execution = await lane.inspectExecution(BACKGROUND_CONTEXT);
    if (execution.current?.id !== operationId) {
      return { status: "not-found" as const };
    }
    const cancelled = await lane.requestAbort(operationId, BACKGROUND_CONTEXT);
    if (!cancelled.ok) throw cancelled.error;
    return { status: "cancelled" as const };
  }
}
