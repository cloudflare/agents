export interface HarnessSubmitOptions {
  readonly runId?: string;
  readonly idempotencyKey?: string;
  readonly retain?: boolean;
}

export interface HarnessSendOptions {
  readonly eventId: string;
  readonly expiresAt?: number | Date;
}

export interface HarnessReceipt {
  readonly runId: string;
  readonly accepted: boolean;
  readonly createdAt: number;
}

/**
 * Transport-neutral lifecycle and control contract for an agent harness.
 *
 * Input, events, snapshots, results, and delivery outcomes remain owned by the
 * implementation. Durable abort is intentionally separate from cancellation
 * of one caller's invocation.
 */
export interface AgentHarness<
  Input,
  Event,
  Snapshot,
  Result,
  Delivery = unknown
> {
  submit(input: Input, options?: HarnessSubmitOptions): Promise<HarnessReceipt>;
  send(
    runId: string,
    event: Event,
    options: HarnessSendOptions
  ): Promise<Delivery>;
  inspect(runId: string): Promise<Snapshot | null>;
  abort(runId: string, reason?: string): Promise<boolean>;
  pause(runId: string): Promise<boolean>;
  resume(runId: string): Promise<boolean>;
  result(runId: string): Promise<Result | null>;
}

/** Optional durable-output discovery, independent of any chunk format. */
export interface HarnessStreams<Descriptor> {
  streams(runId: string): Promise<readonly Descriptor[]>;
}
