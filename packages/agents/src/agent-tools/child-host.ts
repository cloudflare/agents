import type { UIMessage } from "ai";
import type { AgentToolStoredChunk } from "../agent-tool-types";
import type { LifecycleCapability } from "../lifecycle/capability";

/**
 * Outcome of one child turn, as reported by the harness that actually ran it.
 *
 * `skipped` is a non-outcome: the turn never ran (an empty submission, a
 * cleared chat, or a turn-queue generation change that superseded it). The
 * capability seals those as `error` because
 * {@link import("../agent-tool-types").AgentToolRunStatus} has no `skipped`
 * member and a parent must not read a non-run as success.
 */
export type ChildTurnOutcome = {
  /** Terminal classification of the turn the harness ran. */
  readonly status: "completed" | "error" | "aborted" | "skipped";
  /**
   * The request id the turn actually used. A harness that mints its own id
   * (`AIChatAgent.saveMessages`) reports it here; the capability re-binds the
   * run row to it at terminal so frame attribution and stream lookup agree.
   */
  readonly requestId: string;
  /** Human-readable failure text, when the harness classified one. */
  readonly error?: string;
};

/**
 * The chat harness seam the agent-tools CHILD role needs.
 *
 * Every member replaces a call the child implementation makes today inside
 * `@cloudflare/think`'s `Think` or `@cloudflare/ai-chat`'s `AIChatAgent`; the
 * per-member docs name the code it stands in for. Nothing here knows about
 * SQLite, run rows, tailing, or milestones — that is the capability's own.
 */
export interface AgentToolsChildHost {
  /**
   * Run the child's turn for one agent-tool run and report its terminal.
   *
   * Think: `_runProgrammaticMessagesTurn(requestId, [message], { signal,
   * trigger: "agent-tool" })`, whose `skipped` status — and an `aborted` whose
   * turn-queue generation moved — map to `"skipped"`.
   * ai-chat: `saveMessages(prepare, { signal })`, wrapped in the
   * `_setRequestContext({ agentToolInput })` save/restore and the
   * `_registerAgentToolTurn` binding.
   *
   * `requestId` is a proposal the capability has already bound for live frame
   * attribution. A harness that cannot adopt it must call
   * {@link import("./child").AgentToolsChild.rebindRequestId} with the id it
   * did mint before the turn streams, and report that id back in the outcome.
   */
  runTurn(input: {
    readonly runId: string;
    readonly requestId: string;
    readonly message: UIMessage;
    readonly signal: AbortSignal;
  }): Promise<ChildTurnOutcome>;

  /**
   * Tear down any turn still driving this run that the capability's own
   * controller does not reach — a post-eviction chat-recovery continuation.
   *
   * Think: the `_submissionAbortControllers` sweep in `cancelAgentToolRun`.
   * ai-chat: `abortAllRequests(reason)`.
   */
  abortRun(runId: string, reason?: unknown): void;

  /**
   * Resumable-stream id for a turn's request id, or undefined when the turn
   * never opened one.
   *
   * Think: `_resumableStream.getAllStreamMetadata().find(m => m.request_id ===
   * requestId)?.id`.
   * ai-chat: `_resumableStream.latestStreamInfoForRequest(requestId)?.id`
   * (`_getAgentToolStreamId`).
   */
  streamIdForRequest(requestId: string): string | undefined;

  /**
   * Stored chunks of a resumable stream after `afterIndex`, projected onto the
   * wire shape. The harness maps its own `chunk_index` onto `sequence`: stored
   * index and the live tap sequence share one monotonic line (see
   * {@link import("./child").AgentToolsChild.observeChunk}).
   *
   * Think: `_resumableStream.getStreamChunks(streamId).filter(...).map(...)`.
   * ai-chat: `_getAgentToolStoredChunks(requestId, afterSequence)`.
   */
  readChunks(streamId: string, afterIndex?: number): AgentToolStoredChunk[];

  /**
   * Flush the harness's write-behind chunk buffer so a replay sees everything
   * already produced.
   *
   * Think: `_resumableStream.flushBuffer()`. ai-chat: `_flushChunkBuffer()`.
   */
  flushChunks(): void;

  /**
   * Whether a stream is still writing. Guards the post-eviction reconcile from
   * sealing a run whose recovery turn is still producing.
   *
   * Both hosts: `_resumableStream.hasActiveStream()`.
   */
  hasActiveStream(): boolean;

  /**
   * The child's current transcript. Read for the pre-turn assistant snapshot,
   * for "did recovery produce an assistant turn", and for the default summary.
   *
   * Both hosts: `this.messages`.
   */
  messages(): readonly UIMessage[];

  /**
   * Turn an agent-tool input payload into the synthetic user message that
   * starts the child's turn.
   *
   * Think: `formatAgentToolInput(input)`.
   * ai-chat: `formatAgentToolInput(input, { runId })`.
   */
  formatInput(input: unknown, context: { readonly runId: string }): UIMessage;

  /**
   * Structured output for a finished run, or undefined for none.
   *
   * Think: `getAgentToolOutput(runId)` (undefined by default).
   * ai-chat: `getAgentToolOutput({ runId, input }, messagesAfterStart)`.
   */
  output(
    runId: string,
    messagesAfterStart: readonly UIMessage[],
    input: unknown
  ): unknown;

  /**
   * Concise summary stored on the run row and handed to the parent.
   *
   * Think: `getAgentToolSummary(runId, output)` (final assistant text).
   * ai-chat: `getAgentToolSummary({ runId, input }, output,
   * messagesAfterStart)`.
   */
  summary(
    runId: string,
    output: unknown,
    messagesAfterStart: readonly UIMessage[],
    input: unknown
  ): string;

  /**
   * Broadcast one chat-response frame body under a turn's request id, so a
   * `reportProgress` signal rides the child's own stream to its clients and to
   * a tailing parent. The harness owns its wire type constant.
   *
   * Think: `_broadcastChat({ type: MSG_CHAT_RESPONSE, id, body, done: false })`.
   * ai-chat: `_broadcastChatMessage({ type:
   * MessageType.CF_AGENT_USE_CHAT_RESPONSE, id, body, done: false })`.
   */
  broadcastChunk(requestId: string, body: string): void;

  /**
   * Hold the Durable Object alive for the duration of `fn`. The child's turn
   * outlives the RPC that dispatched it.
   *
   * Both hosts: `keepAliveWhile(fn)`.
   */
  keepAliveWhile<T>(fn: () => Promise<T>): Promise<T>;

  /**
   * The request id of the turn executing right now, used to resolve which run
   * a bare `reportProgress()` belongs to.
   *
   * Think: `admittedTurnContext.getStore()?.requestId`.
   * ai-chat: `_activeRequestId`.
   */
  activeRequestId(): string | undefined;
}

const childHosts = new WeakMap<object, AgentToolsChildHost>();

/**
 * @internal Supply the chat-harness seam an installed
 * {@link import("./child").AgentToolsChild} runs against.
 *
 * A composition-root aperture in the shape Scheduler uses for
 * `setSchedulerCallbackResolver`: the host binds itself once (in its
 * constructor, next to `Lifecycle.use()`), and the capability's public API
 * stays free of host types. A capability with no host bound answers reads from
 * its own tables and refuses to start runs.
 *
 * @param capability - The child capability being wired.
 * @param host - The harness seam it should drive.
 */
export function setAgentToolsChildHost(
  capability: LifecycleCapability,
  host: AgentToolsChildHost
): void {
  childHosts.set(capability, host);
}

/** @internal Read the harness seam bound to a capability, if any. */
export function agentToolsChildHost(
  capability: LifecycleCapability
): AgentToolsChildHost | undefined {
  return childHosts.get(capability);
}
