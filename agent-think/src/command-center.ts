/**
 * CommandCenterAgent — the singleton registry behind the command-center UI.
 *
 * One instance (name "main") holds a synced-state index of every thread the
 * worker has ever dispatched: repo/issue coordinates, live status, and
 * per-thread tool counters. ThinkAgent reports lifecycle events here
 * fire-and-forget (see `#report` in agent.ts) — a reporting failure must
 * never break a run, and the command center never drives runs, it only
 * observes them.
 *
 * The UI connects with `useAgent({ agent: "command-center", name: "main" })`
 * and receives every update through the agents SDK state sync, which is what
 * makes the sidebar + metrics live without polling.
 */

import { Agent } from "agents";

export type ThreadStatus = "running" | "done" | "error";

export interface ThreadMeta {
  /** Session slug — also the /thread/:session route (e.g. cloudflare-agents-1859). */
  session: string;
  repo: string;
  issueNumber: number;
  /** Latest instruction the user typed after @agent-think. */
  instruction: string;
  status: ThreadStatus;
  /** First dispatch, epoch ms. */
  createdAt: number;
  /** Last reported event, epoch ms. */
  updatedAt: number;
  /** Dispatches seen for this thread (re-mentions included). */
  runs: number;
  /** Tool calls across all runs. */
  tools: number;
  /** Failed tool calls across all runs. */
  toolErrors: number;
  /** Truncated message of the last turn error, if the last turn failed. */
  lastError?: string;
}

export interface CommandCenterState {
  threads: Record<string, ThreadMeta>;
}

export class CommandCenterAgent extends Agent<Env, CommandCenterState> {
  initialState: CommandCenterState = { threads: {} };

  /** A dispatch landed for a session (new thread, or a re-mention). */
  async recordDispatch(input: {
    session: string;
    repo: string;
    issueNumber: number;
    instruction: string;
  }): Promise<void> {
    const now = Date.now();
    const prev = this.state.threads[input.session];
    this.#put({
      session: input.session,
      repo: input.repo,
      issueNumber: input.issueNumber,
      instruction: input.instruction,
      status: "running",
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      runs: (prev?.runs ?? 0) + 1,
      tools: prev?.tools ?? 0,
      toolErrors: prev?.toolErrors ?? 0
    });
  }

  /** One tool call finished inside a thread's turn. */
  async recordTool(input: { session: string; ok: boolean }): Promise<void> {
    const prev = this.state.threads[input.session];
    if (!prev) return;
    this.#put({
      ...prev,
      updatedAt: Date.now(),
      tools: prev.tools + 1,
      toolErrors: prev.toolErrors + (input.ok ? 0 : 1)
    });
  }

  /** A turn reached a terminal state. */
  async recordTurn(input: {
    session: string;
    outcome: "done" | "error";
    error?: string;
  }): Promise<void> {
    const prev = this.state.threads[input.session];
    if (!prev) return;
    this.#put({
      ...prev,
      status: input.outcome,
      updatedAt: Date.now(),
      ...(input.outcome === "error"
        ? { lastError: input.error?.slice(0, 300) }
        : { lastError: undefined })
    });
  }

  /** Read-only snapshot for the HTTP fallback (see /api/command-center). */
  async getSnapshot(): Promise<CommandCenterState> {
    return this.state;
  }

  #put(meta: ThreadMeta): void {
    // One structured line per update so runs are reconstructable from the
    // observability logs (the registry itself has no other log output).
    console.log(
      `command-center ${JSON.stringify({ session: meta.session, status: meta.status, tools: meta.tools })}`
    );
    this.setState({
      threads: { ...this.state.threads, [meta.session]: meta }
    });
  }
}
