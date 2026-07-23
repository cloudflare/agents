/**
 * CommandCenterAgent — the singleton registry behind the command-center UI.
 *
 * One instance (name "main") holds a synced-state index of every thread the
 * worker has ever dispatched: repo/issue coordinates, live status, and
 * per-thread tool counters. ThinkAgent reports lifecycle events here
 * fire-and-forget (see `#report` in agent.ts) — a reporting failure must
 * never break a run. The only control mutation is an atomic claim for
 * continuing a failed run from the operator command center.
 *
 * The UI connects with `useAgent({ agent: "command-center", name: "main" })`
 * and receives every update through the agents SDK state sync, which is what
 * makes the sidebar + metrics live without polling.
 */

import { Agent } from "agents";
import { STALE_RUN_MS } from "./run-status";

export type ThreadStatus = "running" | "recovering" | "done" | "error";

export interface ThreadMeta {
  /** Session slug — also the /thread/:session route (e.g. cloudflare-agents-1859). */
  session: string;
  repo: string;
  issueNumber: number;
  /** Latest instruction the user typed after @agent-think. */
  instruction: string;
  /** GitHub issue title (as of the dispatch). */
  issueTitle?: string;
  /** Who asked agent-think to look at it. */
  requestedBy?: { login: string; avatarUrl?: string };
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
  /** Truncated terminal reason when the last turn did not complete. */
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
    issueTitle?: string;
    requestedBy?: { login: string; avatarUrl?: string };
  }): Promise<void> {
    const now = Date.now();
    const prev = this.state.threads[input.session];
    this.#put({
      session: input.session,
      repo: input.repo,
      issueNumber: input.issueNumber,
      instruction: input.instruction,
      issueTitle: input.issueTitle ?? prev?.issueTitle,
      requestedBy: input.requestedBy ?? prev?.requestedBy,
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

  /** A recoverable interruption was detected; no terminal outcome exists yet. */
  async recordRecovery(input: { session: string }): Promise<void> {
    this.#setActiveStatus(input.session, "recovering");
  }

  /** Recovery entered a fresh continuation invocation. */
  async recordRunning(input: { session: string }): Promise<void> {
    this.#setActiveStatus(input.session, "running");
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

  async claimContinuation(
    session: string
  ): Promise<
    | { ok: true; thread: ThreadMeta }
    | { ok: false; reason: "not_found" | "not_recoverable" }
  > {
    const thread = this.state.threads[session];
    if (!thread) return { ok: false, reason: "not_found" };
    const staleRunning =
      thread.status === "running" &&
      Date.now() - thread.updatedAt >= STALE_RUN_MS;
    if (thread.status !== "error" && !staleRunning) {
      return { ok: false, reason: "not_recoverable" };
    }
    this.#put({
      ...thread,
      status: "running",
      updatedAt: Date.now(),
      runs: thread.runs + 1,
      lastError: undefined
    });
    return { ok: true, thread };
  }

  #setActiveStatus(session: string, status: "recovering" | "running"): void {
    const prev = this.state.threads[session];
    if (!prev || prev.status === "done") return;
    this.#put({
      ...prev,
      status,
      updatedAt: Date.now(),
      lastError: undefined
    });
  }

  #put(meta: ThreadMeta): void {
    // One structured line per update so runs are reconstructable from the
    // observability logs (the registry itself has no other log output).
    console.log(
      `command-center ${JSON.stringify({
        session: meta.session,
        status: meta.status,
        tools: meta.tools,
        ...(meta.lastError ? { lastError: meta.lastError } : {})
      })}`
    );
    this.setState({
      threads: { ...this.state.threads, [meta.session]: meta }
    });
  }
}
