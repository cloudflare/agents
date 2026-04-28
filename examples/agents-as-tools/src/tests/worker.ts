/**
 * Test worker for `examples/agents-as-tools`.
 *
 * Subclasses the production `Assistant` and `Researcher` classes with
 * test-only RPC methods that let tests seed `cf_agent_helper_runs`
 * rows and helper stored events directly, without driving the real
 * `runResearchHelper` end-to-end (which would require a Workers AI
 * binding for the synthesis step).
 *
 * Mirrors the pattern in `packages/ai-chat/src/tests/worker.ts`:
 * test agents subclass production agents and add seed/inspect
 * helpers; production code stays untouched (modulo a single
 * `protected` modifier on `Researcher._stream` so this subclass can
 * write into the helper's `ResumableStream` without hacks).
 */

import { routeAgentRequest } from "agents";
import {
  Assistant as ProductionAssistant,
  Researcher as ProductionResearcher
} from "../server";
import type { HelperEvent } from "../protocol";

type HelperRunStatus = "running" | "completed" | "error" | "interrupted";

interface SeedRunArgs {
  helperId: string;
  parentToolCallId: string;
  status: HelperRunStatus;
  events?: HelperEvent[];
  startedAt?: number;
  completedAt?: number | null;
}

interface HelperRunRow {
  helper_id: string;
  parent_tool_call_id: string;
  status: HelperRunStatus;
  started_at: number;
  completed_at: number | null;
}

/**
 * Production `Assistant` plus test-only seed/inspect methods. Mounted
 * at the same `Assistant` namespace name so the production routing
 * primitive picks this class up; production code paths are unchanged.
 */
export class Assistant extends ProductionAssistant {
  /**
   * Insert a `cf_agent_helper_runs` row directly. Optionally seeds
   * helper-side stored events into the named Researcher facet.
   *
   * Used by replay tests to construct a specific lifecycle state
   * (e.g. an "error" run with no terminal event) that would otherwise
   * require driving the full helper end-to-end.
   */
  async testSeedHelperRun(args: SeedRunArgs): Promise<void> {
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
        status,
        started_at,
        completed_at
      )
      values (
        ${args.helperId},
        ${args.parentToolCallId},
        ${args.status},
        ${startedAt},
        ${completedAt}
      )
    `;

    if (args.events && args.events.length > 0) {
      const helper = await this.subAgent(Researcher, args.helperId);
      await helper.testWriteEvents(args.helperId, args.events);
    }
  }

  /** Read all rows in `cf_agent_helper_runs`. */
  async testReadHelperRuns(): Promise<HelperRunRow[]> {
    return this.sql<HelperRunRow>`
      select helper_id, parent_tool_call_id, status, started_at, completed_at
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
   * Drive {@link Researcher.startAndStream} end-to-end through the
   * parent and return the decoded NDJSON frames in order.
   *
   * The byte-stream contract test runs through this seam because
   * `Researcher` is a facet of `Assistant` — there is no top-level
   * binding the test can open a stub against. Routing through
   * `subAgent` (the production code path) also exercises the facet
   * resolution + JSRPC serialization that production uses.
   *
   * `synthesize` will throw because `env.AI` is unbound in the test
   * wrangler; the helper's `try`/`catch` translates that into a
   * terminal `error` event before the stream closes, so the returned
   * array is a complete `started → step → tool-call → tool-result …
   * → error` timeline. That's enough to assert sequence ordering, the
   * NDJSON envelope, and the error-path contract.
   */
  async testRunHelperToCompletion(
    helperId: string,
    query: string
  ): Promise<Array<{ sequence: number; body: string }>> {
    const helper = await this.subAgent(Researcher, helperId);
    const stream = await helper.startAndStream(query, helperId);
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

  /** Read stored events from the helper sub-agent (proxies the helper RPC). */
  async testReadStoredHelperEvents(
    helperId: string
  ): Promise<Array<{ chunkIndex: number; body: string }>> {
    const helper = await this.subAgent(Researcher, helperId);
    return helper.getStoredEventsForRun(helperId);
  }
}

/**
 * Production `Researcher` plus test-only seed methods. Writes events
 * into the helper's own `ResumableStream` and `helper_streams` table
 * exactly the way production `startAndStream` would.
 */
export class Researcher extends ProductionResearcher {
  async testWriteEvents(
    runId: string,
    events: HelperEvent[]
  ): Promise<{ streamId: string }> {
    this.sql`create table if not exists helper_streams (
      run_id text primary key,
      stream_id text not null
    )`;

    const stream = this.stream;
    const streamId = stream.start(runId);
    this.sql`
      insert into helper_streams (run_id, stream_id)
      values (${runId}, ${streamId})
      on conflict(run_id) do update set stream_id = excluded.stream_id
    `;

    for (const event of events) {
      stream.storeChunk(streamId, JSON.stringify(event));
    }
    stream.flushBuffer();

    // Mark the helper's own stream completed if the seeded events
    // include a terminal event. Otherwise leave it streaming so
    // `stream.activeStreamId` matches a "running" parent row.
    const terminal = events.find(
      (e) => e.kind === "finished" || e.kind === "error"
    );
    if (terminal?.kind === "finished") {
      stream.complete(streamId);
    } else if (terminal?.kind === "error") {
      stream.markError(streamId);
    }

    return { streamId };
  }
}

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
