import {
  Think,
  hostAgent,
  type ChatMessage,
  type ModelClient,
  type ModelRequest,
} from "../compat.js";

type TestStreamStatus = "streaming" | "completed" | "error";

type TestStreamRow = {
  streamId: string;
  requestId: string;
  status: TestStreamStatus;
  ageMs: number;
  chunks: Array<{ body: string; ageMs: number }>;
};

type StreamSnapshot = {
  requestId: string;
  chunkCount: number;
};

function recoveryModel(): ModelClient {
  return {
    async *stream(): AsyncIterable<import("../compat.js").ModelChunk> {
      yield { type: "text-delta", text: "Continued response." };
      yield { type: "finish", finishReason: "stop" };
    },
  };
}

class ThinkRecoveryTestAgentImpl extends Think {
  private capturedTurnChannels: string[] = [];
  private capturedTurnSystems: string[] = [];
  private turnClientToolNames: string[][] = [];

  protected override configureChannels() {
    return {
      voice: {
        kind: "voice" as const,
        instructions: "VOICE MODE",
        tools: () => ({
          voiceMarker: {
            description: "voice-only marker tool",
            inputSchema: { jsonSchema: { type: "object" } },
            execute: () => "ok"
          }
        }),
        maxTurns: 3
      }
    };
  }

  protected override getModel(): ModelClient {
    const model = recoveryModel();
    const agent = this;
    return {
      async *stream(request: ModelRequest) {
        agent.capturedTurnSystems.push(request.system ?? "");
        agent.turnClientToolNames.push(
          request.tools.map((descriptor) => descriptor.name)
        );
        yield* model.stream(request);
      }
    };
  }

  override beforeTurn = (ctx: { channelId?: string }): void => {
    this.capturedTurnChannels.push(ctx.channelId ?? "");
  };

  async seedAgentToolChildRunForTest(
    runId: string,
    requestId: string,
    _startedAt?: number
  ): Promise<void> {
    this.host.store.put(`test:child-run:${runId}`, requestId);
    this.host.store.put(`test:req-run:${requestId}`, runId);
    this.host.store.put("test:last-run-id", runId);
  }

  async persistTestMessage(msg: ChatMessage): Promise<void> {
    const messages = this.host.store.get<ChatMessage[]>("test:messages") ?? [];
    messages.push(msg);
    this.host.store.put("test:messages", messages);
    const session = await this.ensureSession();
    await session.appendMessage(msg);
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

  async insertAgedStreamForTest(
    streamId: string,
    requestId: string,
    status: TestStreamStatus,
    ageMs: number
  ): Promise<void> {
    this.host.store.put<TestStreamRow>(`test:stream:${streamId}`, {
      streamId,
      requestId,
      status,
      ageMs,
      chunks: []
    });
  }

  async completeStreamForTest(streamId: string): Promise<void> {
    const row = this.host.store.get<TestStreamRow>(`test:stream:${streamId}`);
    if (!row) return;
    this.host.store.put<TestStreamRow>(`test:stream:${streamId}`, {
      ...row,
      status: "completed"
    });
  }

  async runStreamCleanupForTest(): Promise<void> {
    // Divergence: the rebuild replays from the event log and has no original
    // stream-buffer cleanup alarm/table to sweep here.
  }

  async fireDueCleanupAlarmForTest(): Promise<void> {
    await this.runStreamCleanupForTest();
  }

  async armStreamCleanupForTest(): Promise<void> {
    // No equivalent cleanup alarm exists in the rebuild.
  }

  async startStreamForTest(requestId: string): Promise<string> {
    const streamId = `stream-${crypto.randomUUID()}`;
    await this.insertAgedStreamForTest(streamId, requestId, "streaming", 0);
    return streamId;
  }

  async streamCleanupScheduleDelaySecondsForTest(): Promise<number> {
    return 0;
  }

  async getStreamStatusForTest(
    streamId: string
  ): Promise<TestStreamStatus | null> {
    return (
      this.host.store.get<TestStreamRow>(`test:stream:${streamId}`)?.status ??
      null
    );
  }

  async insertStreamChunkForTest(
    streamId: string,
    ageMs: number
  ): Promise<void> {
    const row = this.host.store.get<TestStreamRow>(`test:stream:${streamId}`);
    if (!row) return;
    this.host.store.put<TestStreamRow>(`test:stream:${streamId}`, {
      ...row,
      chunks: [
        ...row.chunks,
        {
          body: JSON.stringify({
            type: "text-delta",
            id: "t1",
            delta: "partial response"
          }),
          ageMs
        }
      ]
    });
  }

  async getLatestStreamSnapshot(): Promise<StreamSnapshot | null> {
    return null;
  }

  async hasAgentToolChildRunTableForTest(): Promise<boolean> {
    return false;
  }

  async rebindAgentToolChildRunRequestIdForTest(
    _requestId: string
  ): Promise<void> {
    throw new Error(
      "missing-feature ISSUE-035: agent-tool child-run request-id rebind is not implemented in the rebuild"
    );
  }

  async seedSettledAgentToolChildRunForTest(
    _runId: string,
    _requestId: string
  ): Promise<void> {
    // ISSUE-035: no child-run bookkeeping table exists to seed.
  }

  async runScheduledRecoveryContinueForTest(): Promise<void> {
    this.rebindLastRun("req-recovered-continue");
    await this.runRecoveredTurn();
  }

  async runScheduledRecoveryRetryForTest(): Promise<void> {
    this.rebindLastRun("req-recovered-retry");
    await this.runRecoveredTurn();
  }

  private async runRecoveredTurn(): Promise<void> {
    const messages = await this.getStoredMessages();
    const user = [...messages].reverse().find((message) => message.role === "user");
    const channel = this.channelFromMessage(user);
    if (channel) {
      await this.runTurn({
        input: [],
        mode: "wait",
        channel
      });
      return;
    }
    await this.runTurn({
      input: [],
      mode: "wait"
    });
  }

  private channelFromMessage(message: ChatMessage | undefined): string | undefined {
    const metadata = message?.metadata;
    if (
      metadata !== undefined &&
      typeof metadata === "object" &&
      metadata !== null &&
      "channel" in metadata &&
      typeof metadata.channel === "string"
    ) {
      return metadata.channel;
    }
    return undefined;
  }

  async getStoredMessages(): Promise<ChatMessage[]> {
    const session = await this.ensureSession();
    return session.getHistory();
  }

  async getCapturedTurnChannelsForTest(): Promise<string[]> {
    return this.capturedTurnChannels;
  }

  async getCapturedTurnSystemsForTest(): Promise<string[]> {
    return this.capturedTurnSystems;
  }

  async getTurnClientToolNames(): Promise<string[][]> {
    return this.turnClientToolNames;
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
    requestId: string,
    startedAt?: number
  ): Promise<void> {
    return this.withAgent((agent) =>
      agent.seedAgentToolChildRunForTest(runId, requestId, startedAt)
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

  insertAgedStreamForTest(
    streamId: string,
    requestId: string,
    status: TestStreamStatus,
    ageMs: number
  ): Promise<void> {
    return this.withAgent((agent) =>
      agent.insertAgedStreamForTest(streamId, requestId, status, ageMs)
    );
  }

  completeStreamForTest(streamId: string): Promise<void> {
    return this.withAgent((agent) => agent.completeStreamForTest(streamId));
  }

  runStreamCleanupForTest(): Promise<void> {
    return this.withAgent((agent) => agent.runStreamCleanupForTest());
  }

  fireDueCleanupAlarmForTest(): Promise<void> {
    return this.withAgent((agent) => agent.fireDueCleanupAlarmForTest());
  }

  armStreamCleanupForTest(): Promise<void> {
    return this.withAgent((agent) => agent.armStreamCleanupForTest());
  }

  startStreamForTest(requestId: string): Promise<string> {
    return this.withAgent((agent) => agent.startStreamForTest(requestId));
  }

  streamCleanupScheduleDelaySecondsForTest(): Promise<number> {
    return this.withAgent((agent) =>
      agent.streamCleanupScheduleDelaySecondsForTest()
    );
  }

  getStreamStatusForTest(
    streamId: string
  ): Promise<TestStreamStatus | null> {
    return this.withAgent((agent) => agent.getStreamStatusForTest(streamId));
  }

  insertStreamChunkForTest(streamId: string, ageMs: number): Promise<void> {
    return this.withAgent((agent) =>
      agent.insertStreamChunkForTest(streamId, ageMs)
    );
  }

  getLatestStreamSnapshot(): Promise<StreamSnapshot | null> {
    return this.withAgent((agent) => agent.getLatestStreamSnapshot());
  }

  hasAgentToolChildRunTableForTest(): Promise<boolean> {
    return this.withAgent((agent) =>
      agent.hasAgentToolChildRunTableForTest()
    );
  }

  rebindAgentToolChildRunRequestIdForTest(
    requestId: string
  ): Promise<void> {
    return this.withAgent((agent) =>
      agent.rebindAgentToolChildRunRequestIdForTest(requestId)
    );
  }

  seedSettledAgentToolChildRunForTest(
    runId: string,
    requestId: string
  ): Promise<void> {
    return this.withAgent((agent) =>
      agent.seedSettledAgentToolChildRunForTest(runId, requestId)
    );
  }

  runScheduledRecoveryContinueForTest(): Promise<void> {
    return this.withAgent((agent) => agent.runScheduledRecoveryContinueForTest());
  }

  runScheduledRecoveryRetryForTest(): Promise<void> {
    return this.withAgent((agent) => agent.runScheduledRecoveryRetryForTest());
  }

  getStoredMessages(): Promise<ChatMessage[]> {
    return this.withAgent((agent) => agent.getStoredMessages());
  }

  getCapturedTurnChannelsForTest(): Promise<string[]> {
    return this.withAgent((agent) => agent.getCapturedTurnChannelsForTest());
  }

  getCapturedTurnSystemsForTest(): Promise<string[]> {
    return this.withAgent((agent) => agent.getCapturedTurnSystemsForTest());
  }

  getTurnClientToolNames(): Promise<string[][]> {
    return this.withAgent((agent) => agent.getTurnClientToolNames());
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
