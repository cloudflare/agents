/**
 * Test worker for `examples/agents-as-tools`.
 *
 * Subclasses the production `Assistant` and `Researcher` classes with
 * test-only RPC methods that let tests seed `cf_agent_helper_runs`
 * rows and helper stored chunks directly, without driving the real
 * `runResearchHelper` end-to-end against Workers AI.
 *
 * `TestResearcher` overrides `getModel()` to return a deterministic
 * mock `LanguageModel` (V3) so the helper's Think inference loop runs
 * end-to-end inside the harness. The mock emits a single text-delta
 * + finish chunk pair — enough to exercise the byte-stream contract,
 * the chunk forwarding path, and the reconnect-replay round-trip
 * without needing a wrangler login or Workers AI quota.
 *
 * Mirrors the pattern in `packages/think/src/tests/agents/think-session.ts`.
 */

import { routeAgentRequest } from "agents";
import {
  Assistant as ProductionAssistant,
  Researcher as ProductionResearcher
} from "../server";
import type { LanguageModel } from "ai";

type HelperRunStatus = "running" | "completed" | "error" | "interrupted";

interface SeedRunArgs {
  helperId: string;
  parentToolCallId: string;
  helperType?: string;
  query?: string;
  status: HelperRunStatus;
  summary?: string | null;
  errorMessage?: string | null;
  /**
   * Display order within the parent tool call's helper bucket. Used
   * by the replay path to synthesize `started` events with an
   * `order` field that the client sorts on. Optional; defaults to 0
   * (matches the schema default for rows that pre-date the
   * `display_order` column).
   */
  displayOrder?: number;
  /**
   * Pre-stringified `UIMessageChunk` bodies to write into the helper's
   * own `_resumableStream`, in order. Each becomes one stored chunk.
   * Optional — replay tests can seed just a row to exercise the
   * "no stored chunks" path.
   */
  chunks?: string[];
  startedAt?: number;
  completedAt?: number | null;
}

interface HelperRunRow {
  helper_id: string;
  parent_tool_call_id: string;
  helper_type: string;
  query: string;
  status: HelperRunStatus;
  summary: string | null;
  error_message: string | null;
  started_at: number;
  completed_at: number | null;
  display_order: number;
}

/**
 * Production `Assistant` plus test-only seed/inspect methods. Mounted
 * at the same `Assistant` namespace name so the production routing
 * primitive picks this class up; production code paths are unchanged.
 */
export class Assistant extends ProductionAssistant {
  /**
   * Insert a `cf_agent_helper_runs` row directly. Optionally seeds
   * helper-side stored chat chunks into the named Researcher facet's
   * own `_resumableStream`.
   *
   * Used by replay tests to construct a specific lifecycle state
   * (e.g. an `error` run with no terminal chunk) that would
   * otherwise require driving the full helper end-to-end.
   */
  async testSeedHelperRun(args: SeedRunArgs): Promise<void> {
    const helperType = args.helperType ?? Researcher.name;
    const query = args.query ?? "test query";
    const startedAt = args.startedAt ?? Date.now();
    const completedAt =
      args.completedAt === undefined
        ? args.status === "running"
          ? null
          : Date.now()
        : args.completedAt;

    this.sql`
      insert into cf_agent_helper_runs (
        helper_id,
        parent_tool_call_id,
        helper_type,
        query,
        status,
        summary,
        error_message,
        started_at,
        completed_at,
        display_order
      )
      values (
        ${args.helperId},
        ${args.parentToolCallId},
        ${helperType},
        ${query},
        ${args.status},
        ${args.summary ?? null},
        ${args.errorMessage ?? null},
        ${startedAt},
        ${completedAt},
        ${args.displayOrder ?? 0}
      )
    `;

    if (args.chunks && args.chunks.length > 0) {
      const helper = await this.subAgent(Researcher, args.helperId);
      await helper.testWriteChunks(args.chunks, args.status);
    }
  }

  /** Read all rows in `cf_agent_helper_runs`. */
  async testReadHelperRuns(): Promise<HelperRunRow[]> {
    return this.sql<HelperRunRow>`
      select helper_id, parent_tool_call_id, helper_type, query, status,
             summary, error_message, started_at, completed_at, display_order
      from cf_agent_helper_runs
      order by started_at asc
    `;
  }

  /** True if a helper sub-agent with this name exists in the registry. */
  hasHelper(helperId: string): boolean {
    return this.hasSubAgent("Researcher", helperId);
  }

  /**
   * Re-run the production `onStart` body. Used by tests to simulate a
   * parent-wake transition (interrupted sweep + table init) without
   * needing to actually hibernate/wake the DO.
   */
  async testRerunOnStart(): Promise<void> {
    this.onStart();
  }

  /**
   * Drive {@link Researcher.runTurnAndStream} end-to-end through the
   * parent and return the decoded NDJSON frames in order. Routes
   * through the production `subAgent` resolution path (so facet
   * resolution + JSRPC serialization match production) and uses the
   * test-only mock model so no Workers AI binding is required.
   */
  async testRunHelperToCompletion(
    helperId: string,
    query: string
  ): Promise<Array<{ sequence: number; body: string }>> {
    const helper = await this.subAgent(Researcher, helperId);
    const stream = await helper.runTurnAndStream(query, helperId);
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const frames: Array<{ sequence: number; body: string }> = [];
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (buf.trim().length > 0) {
          try {
            frames.push(JSON.parse(buf) as { sequence: number; body: string });
          } catch {
            // Trailing junk — ignore.
          }
        }
        break;
      }
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length === 0) continue;
        try {
          frames.push(JSON.parse(line) as { sequence: number; body: string });
        } catch {
          // Skip malformed line.
        }
      }
    }
    return frames;
  }

  /** Read stored chat chunks from the helper sub-agent (proxies the helper RPC). */
  async testReadStoredHelperChunks(
    helperId: string
  ): Promise<Array<{ chunkIndex: number; body: string }>> {
    const helper = await this.subAgent(Researcher, helperId);
    return helper.getChatChunksForReplay();
  }

  /** Read the helper's final-turn assistant text via DO RPC. */
  async testReadHelperFinalText(helperId: string): Promise<string | null> {
    const helper = await this.subAgent(Researcher, helperId);
    return helper.getFinalTurnText();
  }

  /** Read the helper's stashed last stream-error via DO RPC. */
  async testReadHelperStreamError(helperId: string): Promise<string | null> {
    const helper = await this.subAgent(Researcher, helperId);
    return helper.getLastStreamError();
  }

  /**
   * Switch the test helper's mock model into a mode where `doStream`
   * throws synchronously, so the next `runTurnAndStream` exercises the
   * "helper inference errored" path that the parent surfaces via
   * `getLastStreamError`.
   */
  async testSetHelperMockMode(
    helperId: string,
    mode: "ok" | "throws"
  ): Promise<void> {
    const helper = await this.subAgent(Researcher, helperId);
    await helper.testSetMockMode(mode);
  }

  /**
   * Drive a single `runResearchHelper` execution from outside any
   * actual tool call. Mirrors what the production `research` /
   * `compare` tool's `execute` does, but lets the test pick the
   * `parentToolCallId` so it can validate the
   * `(parentToolCallId, helperId)` demux under concurrency.
   *
   * `runResearchHelper` is `private` in production; we reach it via
   * bracket access since adding a public test surface to Assistant
   * would leak past the demo boundary.
   */
  async testRunResearchHelper(
    query: string,
    parentToolCallId: string,
    displayOrder = 0
  ): Promise<{ summary: string }> {
    const fn = (
      this as unknown as {
        runResearchHelper(
          query: string,
          parentToolCallId: string,
          displayOrder?: number
        ): Promise<{ summary: string }>;
      }
    ).runResearchHelper.bind(this);
    return fn(query, parentToolCallId, displayOrder);
  }
}

/**
 * Production `Researcher` plus a deterministic mock model and a
 * test-only chunk-seeder. The mock model lets the harness drive a
 * full Think turn without a Workers AI binding; the seeder writes
 * pre-built `UIMessageChunk` bodies directly into Think's own
 * `_resumableStream` for replay-path tests.
 */
export class Researcher extends ProductionResearcher {
  /** "ok" → emit the deterministic mock chunks. "throws" → `doStream` throws. */
  private _mockMode: "ok" | "throws" = "ok";

  override getModel(): LanguageModel {
    return createMockModel(() => this._mockMode);
  }

  async testSetMockMode(mode: "ok" | "throws"): Promise<void> {
    this._mockMode = mode;
  }

  /**
   * Write the given `UIMessageChunk` bodies into Think's own
   * `_resumableStream` so they appear in `getChatChunksForReplay()`.
   * Status drives the stream's terminal state (`completed` /
   * `markError`); the `running` status leaves the stream `streaming`
   * so the live-read path can be exercised without a fake terminal.
   */
  async testWriteChunks(
    chunks: string[],
    status: HelperRunStatus
  ): Promise<{ streamId: string }> {
    const stream = this._resumableStream;
    const streamId = stream.start(crypto.randomUUID());
    for (const body of chunks) {
      stream.storeChunk(streamId, body);
    }
    stream.flushBuffer();
    if (status === "completed") {
      stream.complete(streamId);
    } else if (status === "error" || status === "interrupted") {
      stream.markError(streamId);
    }
    // status === "running": leave the stream open.
    return { streamId };
  }
}

// ── Mock LanguageModel V3 ──────────────────────────────────────────
//
// Matches the shape used by `packages/think/src/tests/agents/think-session.ts`'s
// `createMockModel` — a deterministic, single-text-response stream
// that produces the chunks Think's `_streamResult` translates into
// UIMessageChunks (text-start / text-delta / text-end / finish).

const MOCK_RESPONSE = "Mock helper synthesis. The fake research is conclusive.";
/** Error message thrown when `mode === "throws"` — exposed for tests to assert on. */
export const MOCK_HELPER_THROWN_ERROR =
  "Simulated helper inference failure (test mock).";

let _mockCallCount = 0;

function createMockModel(mode: () => "ok" | "throws"): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "agents-as-tools-mock",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream() {
      _mockCallCount++;
      const callId = _mockCallCount;
      if (mode() === "throws") {
        // Synchronously throwing inside `doStream` becomes the
        // "stream errored" path inside Think's `_streamResult`,
        // which broadcasts an `error: true` chat-response frame.
        // The Researcher's broadcast tee captures the body into
        // `_lastStreamError`; the parent surfaces it via the
        // helper-event of kind `error`.
        throw new Error(MOCK_HELPER_THROWN_ERROR);
      }
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: `t-${callId}` });
          controller.enqueue({
            type: "text-delta",
            id: `t-${callId}`,
            delta: MOCK_RESPONSE
          });
          controller.enqueue({ type: "text-end", id: `t-${callId}` });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: {
              inputTokens: 10,
              outputTokens: 5,
              totalTokens: 15
            }
          });
          controller.close();
        }
      });
      return Promise.resolve({
        stream,
        request: {},
        response: { headers: {} }
      });
    }
  } as unknown as LanguageModel;
}

/** The text the mock model emits in "ok" mode — exposed so tests can assert against it. */
export const MOCK_HELPER_RESPONSE = MOCK_RESPONSE;

export type Env = {
  Assistant: DurableObjectNamespace<Assistant>;
};

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env, { cors: true })) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
