import {
  Think,
  hostAgent,
  type ChatMessage,
  type ModelClient,
} from "../compat.js";

function recoveryModel(): ModelClient {
  return {
    async *stream(): AsyncIterable<import("../compat.js").ModelChunk> {
      yield { type: "text-delta", text: "Continued response." };
      yield { type: "finish", finishReason: "stop" };
    },
  };
}

class ThinkRecoveryTestAgentImpl extends Think {
  protected override getModel(): ModelClient {
    return recoveryModel();
  }

  async seedAgentToolChildRunForTest(
    runId: string,
    requestId: string
  ): Promise<void> {
    this.host.store.put(`test:child-run:${runId}`, requestId);
    this.host.store.put(`test:req-run:${requestId}`, runId);
    this.host.store.put("test:last-run-id", runId);
  }

  async persistTestMessage(msg: ChatMessage): Promise<void> {
    const messages = this.host.store.get<ChatMessage[]>("test:messages") ?? [];
    messages.push(msg);
    this.host.store.put("test:messages", messages);
  }

  async insertInterruptedStream(
    streamId: string,
    requestId: string,
    chunks: Array<{ body: string; index: number }>
  ): Promise<void> {
    this.host.store.put("test:interrupted-stream", {
      streamId,
      requestId,
      chunks,
    });
  }

  async insertInterruptedFiber(
    name: string,
    payload: unknown
  ): Promise<void> {
    this.host.store.put("test:interrupted-fiber", { name, payload });
  }

  async triggerFiberRecovery(): Promise<void> {
    const callback = this.host.store.get("test:interrupted-stream")
      ? "_chatRecoveryContinue"
      : "_chatRecoveryRetry";
    this.host.store.put(`test:scheduled:${callback}`, 1);
  }

  async getScheduledChatRecoveryCountForTest(
    callback = "_chatRecoveryContinue"
  ): Promise<number> {
    return this.host.store.get<number>(`test:scheduled:${callback}`) ?? 0;
  }

  async runScheduledRecoveryContinueForTest(): Promise<void> {
    this.rebindLastRun("req-recovered-continue");
  }

  async runScheduledRecoveryRetryForTest(): Promise<void> {
    this.rebindLastRun("req-recovered-retry");
  }

  async getAgentToolChildRunRequestIdForTest(
    runId: string
  ): Promise<string | null> {
    return this.host.store.get<string>(`test:child-run:${runId}`) ?? null;
  }

  async resolveAgentToolRunForRequestForTest(
    requestId: string
  ): Promise<string | null> {
    return this.host.store.get<string>(`test:req-run:${requestId}`) ?? null;
  }

  private rebindLastRun(prefix: string): void {
    const runId = this.host.store.get<string>("test:last-run-id");
    if (!runId) return;
    const oldRequestId = this.host.store.get<string>(`test:child-run:${runId}`);
    if (oldRequestId) this.host.store.delete(`test:req-run:${oldRequestId}`);
    const requestId = `${prefix}-${crypto.randomUUID()}`;
    this.host.store.put(`test:child-run:${runId}`, requestId);
    this.host.store.put(`test:req-run:${requestId}`, runId);
  }
}

const ThinkRecoveryTestAgentBase = hostAgent(ThinkRecoveryTestAgentImpl);

export class ThinkRecoveryTestAgent extends ThinkRecoveryTestAgentBase {
  seedAgentToolChildRunForTest(
    runId: string,
    requestId: string
  ): Promise<void> {
    return this.withAgent((agent) =>
      agent.seedAgentToolChildRunForTest(runId, requestId)
    );
  }

  persistTestMessage(msg: ChatMessage): Promise<void> {
    return this.withAgent((agent) => agent.persistTestMessage(msg));
  }

  insertInterruptedStream(
    streamId: string,
    requestId: string,
    chunks: Array<{ body: string; index: number }>
  ): Promise<void> {
    return this.withAgent((agent) =>
      agent.insertInterruptedStream(streamId, requestId, chunks)
    );
  }

  insertInterruptedFiber(name: string, payload: unknown): Promise<void> {
    return this.withAgent((agent) => agent.insertInterruptedFiber(name, payload));
  }

  triggerFiberRecovery(): Promise<void> {
    return this.withAgent((agent) => agent.triggerFiberRecovery());
  }

  getScheduledChatRecoveryCountForTest(callback?: string): Promise<number> {
    return this.withAgent((agent) =>
      agent.getScheduledChatRecoveryCountForTest(callback)
    );
  }

  runScheduledRecoveryContinueForTest(): Promise<void> {
    return this.withAgent((agent) => agent.runScheduledRecoveryContinueForTest());
  }

  runScheduledRecoveryRetryForTest(): Promise<void> {
    return this.withAgent((agent) => agent.runScheduledRecoveryRetryForTest());
  }

  getAgentToolChildRunRequestIdForTest(runId: string): Promise<string | null> {
    return this.withAgent((agent) =>
      agent.getAgentToolChildRunRequestIdForTest(runId)
    );
  }

  resolveAgentToolRunForRequestForTest(
    requestId: string
  ): Promise<string | null> {
    return this.withAgent((agent) =>
      agent.resolveAgentToolRunForRequestForTest(requestId)
    );
  }
}
