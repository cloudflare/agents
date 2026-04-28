/**
 * Test worker for `examples/agents-as-tools`.
 *
 * Subclasses the production `Assistant`, `Researcher`, and `Planner`
 * classes with test-only RPC methods that let tests seed
 * `cf_agent_helper_runs` rows and helper stored chunks directly,
 * without driving real Think turns against Workers AI.
 *
 * Both `Researcher` and `Planner` test subclasses override
 * `getModel()` to return a deterministic mock `LanguageModel` (V3),
 * so each helper's Think inference loop runs end-to-end inside the
 * harness. The mock emits a single text-delta + finish chunk pair —
 * enough to exercise the byte-stream contract, the chunk forwarding
 * path, and the reconnect-replay round-trip without needing a
 * wrangler login or Workers AI quota.
 *
 * Mirrors the pattern in `packages/think/src/tests/agents/think-session.ts`.
 */

import { routeAgentRequest } from "agents";
import {
  Assistant as ProductionAssistant,
  Researcher as ProductionResearcher,
  Planner as ProductionPlanner,
  HelperAgent as ProductionHelperAgent
} from "../server";
import type { LanguageModel } from "ai";

/** Helper class names the test seams accept. */
type HelperClassName = "Researcher" | "Planner";

/**
 * Resolve a helper class name to the matching test subclass. Used
 * by every seam that takes an optional `className` arg — defaults
 * to `Researcher` so existing tests don't have to thread the new
 * parameter through.
 *
 * Returns `typeof ProductionHelperAgent` (the shared production
 * base) rather than the union `typeof Researcher | typeof Planner`
 * because TypeScript's `subAgent<T>` signature can't narrow a union
 * argument to a single `T`. Both test subclasses extend their
 * production class, which extends `HelperAgent`, so this widening
 * is structurally safe — `subAgent` returns a stub whose methods
 * are the ones declared on `HelperAgent` (which is exactly the
 * helper-protocol surface tests use).
 */
function helperClassFor(
  name: HelperClassName | undefined
): typeof ProductionHelperAgent {
  return name === "Planner" ? Planner : Researcher;
}

type HelperRunStatus = "running" | "completed" | "error" | "interrupted";

interface SeedRunArgs {
  helperId: string;
  parentToolCallId: string;
  helperType?: HelperClassName;
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
   * "no stored chunks" path. When provided, the helper's stream id
   * for these chunks is captured and stored as the row's
   * `stream_id` so the replay path resolves to THIS stream.
   */
  chunks?: string[];
  /**
   * Explicit stream id to record on the row (overrides what
   * {@link chunks} captures). Useful for the D1 regression test that
   * needs to seed a row pointing at a specific stream while there
   * are multiple streams stored on the helper.
   */
  streamId?: string | null;
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
  stream_id: string | null;
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

    // Write chunks first (if any) so we can capture the helper's
    // stream id and stamp it onto the row. An explicit `streamId`
    // arg overrides the captured one — used by the D1 test to point
    // at a specific stream when several exist on the helper.
    //
    // Pick the right helper class from `args.helperType`: spawning a
    // `Planner` row's chunks against the Researcher facet would
    // write to the wrong DO and the row's `helper_type` lookup on
    // replay would dispatch to a stub with no stored chunks.
    let writtenStreamId: string | null = null;
    if (args.chunks && args.chunks.length > 0) {
      // Inline narrowing — `testWriteChunks` is a test-only method on
      // the test subclasses, not on the shared production
      // `HelperAgent`, so we have to subAgent through the concrete
      // class (rather than `helperClassFor(...)`) to keep the stub's
      // type narrow enough.
      const result =
        args.helperType === "Planner"
          ? await (
              await this.subAgent(Planner, args.helperId)
            ).testWriteChunks(args.chunks, args.status)
          : await (
              await this.subAgent(Researcher, args.helperId)
            ).testWriteChunks(args.chunks, args.status);
      writtenStreamId = result.streamId;
    }
    const streamId =
      args.streamId !== undefined ? args.streamId : writtenStreamId;

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
        display_order,
        stream_id
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
        ${args.displayOrder ?? 0},
        ${streamId}
      )
    `;
  }

  /** Read all rows in `cf_agent_helper_runs`. */
  async testReadHelperRuns(): Promise<HelperRunRow[]> {
    return this.sql<HelperRunRow>`
      select helper_id, parent_tool_call_id, helper_type, query, status,
             summary, error_message, started_at, completed_at, display_order,
             stream_id
      from cf_agent_helper_runs
      order by started_at asc
    `;
  }

  /**
   * True if a helper sub-agent with this name exists in the registry.
   * `className` selects which class's facet table to check; defaults
   * to `Researcher` for back-compat with existing tests.
   */
  hasHelper(
    helperId: string,
    className: HelperClassName = "Researcher"
  ): boolean {
    return this.hasSubAgent(className, helperId);
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
   * Drive {@link HelperAgent.runTurnAndStream} end-to-end through
   * the parent and return the decoded NDJSON frames in order. Routes
   * through the production `subAgent` resolution path (so facet
   * resolution + JSRPC serialization match production) and uses the
   * test-only mock model so no Workers AI binding is required.
   *
   * `className` picks which helper class to spawn; defaults to
   * `Researcher` for back-compat with existing tests.
   */
  async testRunHelperToCompletion(
    helperId: string,
    query: string,
    className: HelperClassName = "Researcher"
  ): Promise<Array<{ sequence: number; body: string }>> {
    const helper = await this.subAgent(helperClassFor(className), helperId);
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
    helperId: string,
    className: HelperClassName = "Researcher"
  ): Promise<Array<{ chunkIndex: number; body: string }>> {
    const helper = await this.subAgent(helperClassFor(className), helperId);
    return helper.getChatChunksForReplay();
  }

  /** Read the helper's final-turn assistant text via DO RPC. */
  async testReadHelperFinalText(
    helperId: string,
    className: HelperClassName = "Researcher"
  ): Promise<string | null> {
    const helper = await this.subAgent(helperClassFor(className), helperId);
    return helper.getFinalTurnText();
  }

  /** Read the helper's stashed last stream-error via DO RPC. */
  async testReadHelperStreamError(
    helperId: string,
    className: HelperClassName = "Researcher"
  ): Promise<string | null> {
    const helper = await this.subAgent(helperClassFor(className), helperId);
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
    mode: "ok" | "throws",
    className: HelperClassName = "Researcher"
  ): Promise<void> {
    // Narrow to the concrete class — `testSetMockMode` is a
    // test-only method only the test subclasses define.
    if (className === "Planner") {
      const helper = await this.subAgent(Planner, helperId);
      await helper.testSetMockMode(mode);
    } else {
      const helper = await this.subAgent(Researcher, helperId);
      await helper.testSetMockMode(mode);
    }
  }

  /**
   * Drive a single `_runHelperTurn` execution from outside any
   * actual tool call. Mirrors what the production `research` /
   * `plan` / `compare` tool's `execute` does, but lets the test
   * pick the `parentToolCallId` and the helper class so it can
   * validate the `(parentToolCallId, helperId)` demux under
   * concurrency. `className` defaults to `Researcher` so existing
   * fan-out tests don't have to thread the new arg through.
   *
   * `_runHelperTurn` is `private` in production; we reach it via
   * bracket access since adding a public test surface to Assistant
   * would leak past the demo boundary.
   */
  async testRunResearchHelper(
    query: string,
    parentToolCallId: string,
    displayOrder = 0,
    className: HelperClassName = "Researcher"
  ): Promise<{ summary: string }> {
    const cls = className === "Planner" ? Planner : Researcher;
    const fn = (
      this as unknown as {
        _runHelperTurn(
          cls: typeof Researcher | typeof Planner,
          query: string,
          parentToolCallId: string,
          displayOrder?: number
        ): Promise<{ summary: string }>;
      }
    )._runHelperTurn.bind(this);
    return fn(cls, query, parentToolCallId, displayOrder);
  }

  /**
   * Write an additional stream of chunks into the named helper's
   * `_resumableStream` without touching the `cf_agent_helper_runs`
   * row. Used by the D1 regression test to simulate a drill-in
   * follow-up turn (which adds a second stream to the helper but
   * leaves the row's `stream_id` pointing at the original turn).
   */
  async testWriteAdditionalHelperChunks(
    helperId: string,
    chunks: string[],
    className: HelperClassName = "Researcher"
  ): Promise<{ streamId: string }> {
    if (className === "Planner") {
      const helper = await this.subAgent(Planner, helperId);
      return helper.testWriteChunks(chunks, "completed");
    }
    const helper = await this.subAgent(Researcher, helperId);
    return helper.testWriteChunks(chunks, "completed");
  }
}

/**
 * Production `Researcher` plus a deterministic mock model and a
 * test-only chunk-seeder. The mock model lets the harness drive a
 * full Think turn without a Workers AI binding; the seeder writes
 * pre-built `UIMessageChunk` bodies directly into Think's own
 * `_resumableStream` for replay-path tests.
 *
 * `Planner` (below) duplicates the same surface — TypeScript class
 * mixins are gnarly enough that two ~30-line classes is the
 * cheaper-to-read option. Both wrap their respective production
 * classes verbatim except for the test-only mock+seed surface.
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

/**
 * Production `Planner` plus the same test-only surface `Researcher`
 * has. Same mock-model / `testWriteChunks` machinery — only the
 * production class differs. See the `Researcher` test class above
 * for why we duplicate rather than mix in.
 */
export class Planner extends ProductionPlanner {
  /** "ok" → emit the deterministic mock chunks. "throws" → `doStream` throws. */
  private _mockMode: "ok" | "throws" = "ok";

  override getModel(): LanguageModel {
    return createMockModel(() => this._mockMode);
  }

  async testSetMockMode(mode: "ok" | "throws"): Promise<void> {
    this._mockMode = mode;
  }

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
