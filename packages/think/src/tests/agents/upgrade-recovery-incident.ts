import type { LanguageModel, UIMessage } from "ai";
import { Think } from "../../think";

/** The key think@0.24.0 (agents 0.34) kept a chat recovery incident under. */
const RELEASED_INCIDENT_PREFIX = "cf:chat-recovery:incident:";
const HELD_KEY = "test:first-call-held";

/**
 * An agent upgraded over the chat recovery incidents a release kept. Its
 * model's first call never ends (a reset cuts it); every later call answers.
 */
export class ThinkUpgradeRecoveryIncidentAgent extends Think {
  override getModel(): LanguageModel {
    const kv = this.ctx.storage.kv;
    return {
      specificationVersion: "v3",
      provider: "test",
      modelId: "upgrade-incident",
      supportedUrls: {},
      doGenerate() {
        throw new Error("doGenerate not implemented");
      },
      doStream() {
        const first = !kv.get<boolean>(HELD_KEY);
        if (first) kv.put(HELD_KEY, true);
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t" });
            controller.enqueue({ type: "text-delta", id: "t", delta: "Part" });
            // The first call stays open until the reset ends this isolate.
            if (first) return;
            controller.enqueue({ type: "text-delta", id: "t", delta: " done" });
            controller.enqueue({ type: "text-end", id: "t" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
            });
            controller.close();
          }
        });
        return Promise.resolve({ stream });
      }
    } as LanguageModel;
  }

  /**
   * Leave two incidents as the release wrote them (its `ChatRecoveryIncident`
   * record, in Durable Object storage under its key): one inactive past the
   * hour-long TTL, one active a moment ago.
   */
  async leaveReleasedIncidentsForTest(): Promise<void> {
    const now = Date.now();
    // The release's id is `<root request id>:<latest user message id>`
    // (`chatRecoveryIncidentId`), and its key encodes that id.
    const incident = (tag: string, lastAttemptAt: number) => ({
      incidentId: `req-${tag}:u-${tag}`,
      requestId: `req-${tag}`,
      recoveryRootRequestId: `req-${tag}`,
      recoveryKind: "continue",
      attempt: 1,
      maxAttempts: 10,
      status: "scheduled",
      firstSeenAt: lastAttemptAt,
      lastAttemptAt,
      lastProgressAt: lastAttemptAt
    });
    await this.ctx.storage.put(
      `${RELEASED_INCIDENT_PREFIX}${encodeURIComponent("req-stale:u-stale")}`,
      incident("stale", now - 2 * 60 * 60 * 1000)
    );
    await this.ctx.storage.put(
      `${RELEASED_INCIDENT_PREFIX}${encodeURIComponent("req-live:u-live")}`,
      incident("live", now)
    );
  }

  /** Start a turn whose model call the reset will cut; resolves once it's called. */
  async startHeldTurnForTest(): Promise<void> {
    void this.saveMessages([
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "hello" }]
      } as UIMessage
    ]).catch(() => {});
    const deadline = Date.now() + 5_000;
    while (!this.ctx.storage.kv.get<boolean>(HELD_KEY)) {
      if (Date.now() > deadline) throw new Error("the model was never called");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** End this isolate, as an eviction or a deploy does. */
  resetIsolateForTest(): void {
    this.ctx.abort("test reset");
  }

  async incidentIdsForTest(): Promise<string[]> {
    const entries = await this.ctx.storage.list({
      prefix: RELEASED_INCIDENT_PREFIX
    });
    return [...entries.keys()]
      .map((key) =>
        decodeURIComponent(key.slice(RELEASED_INCIDENT_PREFIX.length))
      )
      .sort();
  }

  async replyTextForTest(): Promise<string> {
    const messages = (await this.session.getHistory()) as UIMessage[];
    return messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.parts)
      .map((part) => ("text" in part ? part.text : ""))
      .join("");
  }
}
