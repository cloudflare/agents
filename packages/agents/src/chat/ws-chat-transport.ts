/**
 * WebSocket-based ChatTransport for useAgentChat.
 *
 * Replaces the aiFetch + DefaultChatTransport indirection with a direct
 * WebSocket implementation that speaks the CF_AGENT protocol natively.
 *
 * Data flow (old): WS → aiFetch fake Response → DefaultChatTransport → useChat
 * Data flow (new): WS → WebSocketChatTransport → useChat
 */

import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { nanoid } from "nanoid";
import { MessageType, type OutgoingMessage } from "./wire-types";

/**
 * Short safety-net timeout for a resume probe when the server has said nothing.
 * Under normal operation the server answers a `STREAM_RESUME_REQUEST` with
 * `STREAM_RESUMING`, `STREAM_RESUME_NONE`, or `STREAM_PENDING` well before this.
 */
const RESUME_PROBE_TIMEOUT_MS = 5000;

/**
 * Extended backstop applied once the server says a turn is pending
 * (`STREAM_PENDING`, #1784). The pre-stream window (queueing, MCP setup,
 * debounce, model latency) can exceed the short probe timeout, and the server
 * guarantees a follow-up `STREAM_RESUMING` or `STREAM_RESUME_NONE` — so we wait
 * much longer (refreshed on every keep-waiting frame) but still cap it so a
 * dropped follow-up degrades to a null resolve instead of hanging forever.
 */
const RESUME_PENDING_TIMEOUT_MS = 60000;

/**
 * Agent-like interface for sending/receiving WebSocket messages.
 * Matches the shape returned by useAgent from agents/react.
 */
export interface AgentConnection {
  send: (data: string) => void;
  addEventListener: (
    type: string,
    listener: (event: MessageEvent) => void,
    options?: { signal?: AbortSignal }
  ) => void;
  removeEventListener: (
    type: string,
    listener: (event: MessageEvent) => void
  ) => void;
}

export type WebSocketChatTransportOptions<
  ChatMessage extends UIMessage = UIMessage
> = {
  /** The agent connection from useAgent */
  agent: AgentConnection;
  /**
   * Callback to prepare the request body before sending.
   * Can add custom headers, body fields, or credentials.
   */
  prepareBody?: (options: {
    messages: ChatMessage[];
    trigger: "submit-message" | "regenerate-message";
    messageId?: string;
  }) => Promise<Record<string, unknown>> | Record<string, unknown>;
  /**
   * Optional set to track active request IDs.
   * IDs are added when a request starts and removed when it completes.
   * Used by the onAgentMessage handler to skip messages already handled by the transport.
   */
  activeRequestIds?: Set<string>;
  /**
   * Whether generic client-side abort/cancel lifecycle should cancel the
   * server turn. Explicit cancellation via cancelActiveServerTurn() always
   * sends CF_AGENT_CHAT_REQUEST_CANCEL.
   * @default false
   */
  cancelOnClientAbort?: boolean;
};

/**
 * ChatTransport that sends messages over WebSocket and returns a
 * ReadableStream<UIMessageChunk> that the AI SDK's useChat consumes directly.
 * No fake fetch, no Response reconstruction, no double SSE parsing.
 */
export class WebSocketChatTransport<
  ChatMessage extends UIMessage = UIMessage
> implements ChatTransport<ChatMessage> {
  agent: AgentConnection;
  private prepareBody?: WebSocketChatTransportOptions<ChatMessage>["prepareBody"];
  private activeRequestIds?: Set<string>;
  private cancelOnClientAbort: boolean;

  // Pending resume resolver — set by reconnectToStream, called by
  // handleStreamResuming when onAgentMessage sees CF_AGENT_STREAM_RESUMING.
  private _resumeResolver: ((data: { id: string }) => void) | null = null;
  // Pending "no stream" resolver — called by handleStreamResumeNone
  // when onAgentMessage sees CF_AGENT_STREAM_RESUME_NONE.
  private _resumeNoneResolver:
    | ((data: { probeId?: string }) => boolean)
    | null = null;
  // Keep-waiting hook (#1784) — set by whichever resume path is currently
  // awaiting, called by handleStreamPending when onAgentMessage sees
  // CF_AGENT_STREAM_PENDING. Extends the path's probe timeout so a slow
  // pre-stream window (queue / MCP / model latency) does not resolve early.
  private _onStreamPending: (() => void) | null = null;
  // Retransmits the current handshake on a replacement socket without starting
  // a second AI SDK resume request. Set only while a resolver is active.
  private _retryResumeProbe: (() => void) | null = null;
  // Set when a client-side tool result/approval is expected to trigger
  // a new continuation stream. In this mode reconnectToStream() returns
  // a deferred ReadableStream immediately so AI SDK status can transition
  // to "submitted" before the server starts streaming.
  private _expectToolContinuation = false;
  private _abortToolContinuation: (() => boolean) | null = null;
  private _activeServerTurnId: string | null = null;
  private _cancelAttachedStream: (() => boolean) | null = null;
  // Local-only detach for a resume stream owned by an obsolete Chat/agent
  // generation. Unlike explicit cancellation, this never cancels server work.
  private _detachResumeStream: (() => boolean) | null = null;

  constructor(options: WebSocketChatTransportOptions<ChatMessage>) {
    this.agent = options.agent;
    this.prepareBody = options.prepareBody;
    this.activeRequestIds = options.activeRequestIds;
    this.cancelOnClientAbort = options.cancelOnClientAbort ?? false;
  }

  /**
   * Point the singleton transport at a new Agent connection. A pending resolver
   * belongs to the old Chat/socket generation and must settle before messages
   * from the replacement connection can be consumed (#1914 review).
   */
  setAgent(agent: AgentConnection) {
    if (this.agent === agent) return;
    this.resetResumeState();
    this.agent = agent;
  }

  setCancelOnClientAbort(cancelOnClientAbort: boolean) {
    this.cancelOnClientAbort = cancelOnClientAbort;
  }

  /**
   * Explicitly cancel the active server turn, if any.
   * This is separate from generic client-side abort/cancel lifecycle so
   * clients can detach locally without stopping server work.
   */
  cancelActiveServerTurn(): boolean {
    const requestId = this._activeServerTurnId;
    let cancelledRequest = false;

    if (requestId) {
      this.sendCancelFrame(requestId);
      this._cancelAttachedStream?.();
      this.clearActiveServerTurn(requestId);
      cancelledRequest = true;
    }

    const cancelledToolContinuation = this.abortActiveToolContinuation();
    return cancelledRequest || cancelledToolContinuation;
  }

  private sendCancelFrame(requestId: string) {
    try {
      this.agent.send(
        JSON.stringify({
          id: requestId,
          type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL
        })
      );
    } catch {
      // Ignore failures (e.g. agent already disconnected)
    }
  }

  private setActiveServerTurn(
    requestId: string,
    cancelAttachedStream: (() => boolean) | null
  ) {
    this._activeServerTurnId = requestId;
    this._cancelAttachedStream = cancelAttachedStream;
  }

  private clearActiveServerTurn(requestId: string) {
    if (this._activeServerTurnId === requestId) {
      this._activeServerTurnId = null;
      this._cancelAttachedStream = null;
    }
  }

  /**
   * Mark that the next reconnectToStream() call should attach to a
   * server-initiated tool continuation rather than a page-load resume.
   */
  expectToolContinuation() {
    this._expectToolContinuation = true;
  }

  /**
   * Abort the active client-side tool continuation stream, if one is attached
   * to a server request id.
   */
  abortActiveToolContinuation(): boolean {
    return this._abortToolContinuation?.() ?? false;
  }

  /**
   * True when the transport is waiting for a resume handshake.
   */
  isAwaitingResume(): boolean {
    return this._resumeResolver !== null || this._resumeNoneResolver !== null;
  }

  /**
   * Settle and detach the current handshake without interpreting it as a
   * server-idle response. Used when the owning hook/agent generation changes.
   */
  cancelPendingResume(): boolean {
    const resolveNone = this._resumeNoneResolver;
    if (!resolveNone) return false;
    return resolveNone({});
  }

  /**
   * Invalidate all client-side resume state for an obsolete hook/agent
   * generation without cancelling its durable server turn.
   */
  resetResumeState(): void {
    this._expectToolContinuation = false;
    this.cancelPendingResume();
    this._detachResumeStream?.();
  }

  /**
   * Re-send the active handshake request on the latest socket generation. This
   * preserves one AI SDK resume operation while recovering a request/reply lost
   * with the previous WebSocket.
   */
  retryPendingResume(): boolean {
    const retry = this._retryResumeProbe;
    if (!retry) return false;
    retry();
    return true;
  }

  /**
   * Called by onAgentMessage when it receives CF_AGENT_STREAM_RESUMING.
   * If reconnectToStream is waiting, this handles the resume handshake
   * (ACK + stream creation) and returns true. Otherwise returns false
   * so the caller can use its own fallback path.
   */
  handleStreamResuming(data: { id: string }): boolean {
    if (!this._resumeResolver) return false;
    this._resumeResolver(data);
    return true;
  }

  /**
   * Called by onAgentMessage when it receives CF_AGENT_STREAM_RESUME_NONE.
   * If reconnectToStream is waiting, resolves the promise with null
   * immediately (no 5-second timeout). Returns true if handled.
   */
  handleStreamResumeNone(data: { probeId?: string } = {}): boolean {
    if (!this._resumeNoneResolver) return false;
    return this._resumeNoneResolver(data);
  }

  /**
   * Called by onAgentMessage when it receives CF_AGENT_STREAM_PENDING (#1784):
   * the server accepted a turn but its stream has not started yet. If a resume
   * path is awaiting, extend its probe timeout (so it keeps waiting for the
   * eventual STREAM_RESUMING / STREAM_RESUME_NONE instead of resolving null
   * after the short window). Returns true if a waiting path consumed it.
   */
  handleStreamPending(): boolean {
    if (!this._onStreamPending) return false;
    this._onStreamPending();
    return true;
  }

  /**
   * Called by the hook's shared message handler when a server turn finishes
   * outside the currently attached transport stream, such as after local-only
   * client cleanup.
   */
  handleServerTurnCompleted(requestId: string) {
    this.clearActiveServerTurn(requestId);
  }

  /**
   * Register a server turn that is being rendered outside a transport-owned
   * stream, such as the hook's fallback cross-tab/resume observer path.
   */
  observeServerTurn(requestId: string) {
    this.setActiveServerTurn(requestId, null);
  }

  async sendMessages(options: {
    chatId: string;
    messages: ChatMessage[];
    abortSignal: AbortSignal | undefined;
    trigger: "submit-message" | "regenerate-message";
    messageId?: string;
    body?: object;
    headers?: Record<string, string> | Headers;
    metadata?: unknown;
  }): Promise<ReadableStream<UIMessageChunk>> {
    const requestId = nanoid(8);
    const abortController = new AbortController();
    let completed = false;
    let requestSent = false;

    // Build the request body
    let extraBody: Record<string, unknown> = {};
    if (this.prepareBody) {
      extraBody = await this.prepareBody({
        messages: options.messages,
        trigger: options.trigger,
        messageId: options.messageId
      });
    }
    if (options.body) {
      extraBody = {
        ...extraBody,
        ...(options.body as Record<string, unknown>)
      };
    }

    const bodyPayload = JSON.stringify({
      messages: options.messages,
      trigger: options.trigger,
      ...extraBody
    });

    // Track this request so the onAgentMessage handler skips it
    this.activeRequestIds?.add(requestId);

    // Create a ReadableStream<UIMessageChunk> that emits parsed chunks
    // as they arrive over the WebSocket
    const agent = this.agent;
    const activeIds = this.activeRequestIds;

    // Single cleanup helper — every terminal path (done, error, abort)
    // goes through here exactly once.
    // keepId: when true, do NOT remove requestId from activeIds. Used by
    // explicit cancellation so onAgentMessage skips in-flight chunks
    // and the server's final done:true signal until cleanup happens there.
    const finish = (
      action: () => void,
      keepId = false,
      clearServerTurn = true
    ) => {
      if (completed) return;
      completed = true;
      if (clearServerTurn) {
        this.clearActiveServerTurn(requestId);
      }
      try {
        action();
      } catch {
        // Stream may already be closed
      }
      if (!keepId) {
        activeIds?.delete(requestId);
      }
      abortController.abort();
    };

    const abortError = new Error("Aborted");
    abortError.name = "AbortError";

    const cancelActiveRequest = () => {
      if (completed) return false;
      finish(() => streamController.error(abortError), true);
      return true;
    };
    this.setActiveServerTurn(requestId, cancelActiveRequest);

    // Abort handler: terminate the local stream. By default, generic AI SDK
    // abort/cancel lifecycle is local-only so durable server turns can continue
    // and be resumed. Use cancelActiveServerTurn() for explicit user/app
    // cancellation, or cancelOnClientAbort for request-lifetime semantics.
    const onAbort = () => {
      if (completed) return;
      if (this.cancelOnClientAbort) {
        if (requestSent) {
          this.sendCancelFrame(requestId);
        }
        finish(() => streamController.error(abortError), requestSent);
      } else {
        finish(() => streamController.error(abortError), false, !requestSent);
      }
    };

    // streamController is assigned synchronously by start(), so it is
    // always available by the time onAbort or onMessage can fire.
    let streamController!: ReadableStreamDefaultController<UIMessageChunk>;

    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        streamController = controller;

        const onMessage = (event: MessageEvent) => {
          try {
            const data = JSON.parse(
              event.data as string
            ) as OutgoingMessage<ChatMessage>;

            if (data.type !== MessageType.CF_AGENT_USE_CHAT_RESPONSE) return;
            if (data.id !== requestId) return;

            if (data.error) {
              finish(() =>
                controller.error(new Error(data.body || "Stream error"))
              );
              return;
            }

            // Parse the body as UIMessageChunk and enqueue
            if (data.body?.trim()) {
              try {
                const chunk = JSON.parse(data.body) as UIMessageChunk;
                controller.enqueue(chunk);
              } catch {
                // Skip malformed chunk bodies
              }
            }

            if (data.done) {
              finish(() => controller.close());
            }
          } catch {
            // Ignore non-JSON messages
          }
        };

        const onClose = () => {
          finish(() => controller.close(), false, false);
        };

        agent.addEventListener("message", onMessage, {
          signal: abortController.signal
        });
        agent.addEventListener("close", onClose, {
          signal: abortController.signal
        });
      },
      cancel() {
        onAbort();
      }
    });

    // Handle abort from the caller
    if (options.abortSignal) {
      options.abortSignal.addEventListener("abort", onAbort, { once: true });
      if (options.abortSignal.aborted) onAbort();
    }

    if (completed) {
      return stream;
    }

    // Send the request over WebSocket
    requestSent = true;
    agent.send(
      JSON.stringify({
        id: requestId,
        init: {
          method: "POST",
          body: bodyPayload
        },
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST
      })
    );

    return stream;
  }

  async reconnectToStream(_options: {
    chatId: string;
  }): Promise<ReadableStream<UIMessageChunk> | null> {
    // A transport has one handshake slot. Returning null for an unexpected
    // concurrent caller is safer than overwriting callbacks owned by the first
    // AI SDK request (StrictMode/manual overlap); the hook serializes its normal
    // mount, tool, public, and reconnect entry points.
    if (this.isAwaitingResume()) return null;

    if (this._expectToolContinuation) {
      this._expectToolContinuation = false;
      return this._createToolContinuationStream();
    }

    // Detect whether the server has an active stream for this chat.
    // Instead of registering another message listener (which races with the
    // hook), expose identity-owned callbacks consumed synchronously by the
    // shared handler.
    const activeIds = this.activeRequestIds;
    const probeId = nanoid(8);

    return new Promise<ReadableStream<UIMessageChunk> | null>((resolve) => {
      let resolved = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let resumeResolver: ((data: { id: string }) => void) | null = null;
      let resumeNoneResolver: ((data: { probeId?: string }) => boolean) | null =
        null;
      let onStreamPending: (() => void) | null = null;
      let retryResumeProbe: (() => void) | null = null;

      const clearOwnedCallbacks = () => {
        if (resumeResolver && this._resumeResolver === resumeResolver) {
          this._resumeResolver = null;
        }
        if (
          resumeNoneResolver &&
          this._resumeNoneResolver === resumeNoneResolver
        ) {
          this._resumeNoneResolver = null;
        }
        if (onStreamPending && this._onStreamPending === onStreamPending) {
          this._onStreamPending = null;
        }
        if (retryResumeProbe && this._retryResumeProbe === retryResumeProbe) {
          this._retryResumeProbe = null;
        }
      };

      const done = (value: ReadableStream<UIMessageChunk> | null) => {
        if (resolved) return;
        resolved = true;
        clearOwnedCallbacks();
        if (timeout) clearTimeout(timeout);
        resolve(value);
      };

      const armTimeout = (delay: number) => {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => done(null), delay);
      };

      // Keep-waiting (#1784): the server says a turn is accepted but its stream
      // has not started. Extend this operation's own timeout only.
      onStreamPending = () => {
        if (resolved) return;
        armTimeout(RESUME_PENDING_TIMEOUT_MS);
      };

      resumeNoneResolver = (data) => {
        if (data.probeId && data.probeId !== probeId) return false;
        done(null);
        return true;
      };

      resumeResolver = (data: { id: string }) => {
        const requestId = data.id;
        activeIds?.add(requestId);
        const stream = this._createResumeStream(requestId);

        this.agent.send(
          JSON.stringify({
            type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
            id: requestId
          })
        );

        done(stream);
      };

      // Re-arm both the request and timeout on each replacement socket. This is
      // a retransmission of this resolver's handshake, not a second Chat resume.
      retryResumeProbe = () => {
        if (resolved) return;
        armTimeout(RESUME_PROBE_TIMEOUT_MS);
        try {
          this.agent.send(
            JSON.stringify({
              type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST,
              probeId
            })
          );
        } catch {
          // The next socket open retries again; the timeout remains a backstop.
        }
      };

      this._onStreamPending = onStreamPending;
      this._resumeNoneResolver = resumeNoneResolver;
      this._resumeResolver = resumeResolver;
      this._retryResumeProbe = retryResumeProbe;
      retryResumeProbe();
    });
  }

  /**
   * Creates a deferred ReadableStream for client-side tool continuations.
   * The stream is returned immediately so AI SDK status becomes "submitted"
   * right after addToolOutput()/addToolApprovalResponse(), then it waits for
   * the server to announce the continuation via STREAM_RESUMING.
   */
  private _createToolContinuationStream(): ReadableStream<UIMessageChunk> {
    const agent = this.agent;
    const activeIds = this.activeRequestIds;
    const streamController = new AbortController();
    const abortError = new Error("Aborted");
    abortError.name = "AbortError";
    let completed = false;
    let requestId: string | null = null;
    let readerController: ReadableStreamDefaultController<UIMessageChunk> | null =
      null;
    const probeId = nanoid(8);
    let onResumeRef: ((data: { id: string }) => void) | null = null;
    let onResumeNoneRef: ((data: { probeId?: string }) => boolean) | null =
      null;
    let onStreamPendingRef: (() => void) | null = null;
    let retryResumeProbeRef: (() => void) | null = null;
    let abortToolContinuationRef: (() => boolean) | null = null;
    let detachResumeStreamRef: (() => boolean) | null = null;

    const clearOwnedHandshake = () => {
      if (onResumeRef && this._resumeResolver === onResumeRef) {
        this._resumeResolver = null;
      }
      if (onResumeNoneRef && this._resumeNoneResolver === onResumeNoneRef) {
        this._resumeNoneResolver = null;
      }
      if (onStreamPendingRef && this._onStreamPending === onStreamPendingRef) {
        this._onStreamPending = null;
      }
      if (
        retryResumeProbeRef &&
        this._retryResumeProbe === retryResumeProbeRef
      ) {
        this._retryResumeProbe = null;
      }
    };

    const finish = (action: () => void, keepRequestId = false) => {
      if (completed) return;
      completed = true;
      if (this._abortToolContinuation === abortToolContinuationRef) {
        this._abortToolContinuation = null;
      }
      if (this._detachResumeStream === detachResumeStreamRef) {
        this._detachResumeStream = null;
      }
      clearOwnedHandshake();
      try {
        action();
      } catch {
        // Stream may already be closed
      }
      if (requestId && !keepRequestId) {
        activeIds?.delete(requestId);
      }
      streamController.abort();
    };

    const transport = this;

    abortToolContinuationRef = () => {
      if (completed) return false;

      if (requestId === null) {
        finish(() => readerController?.error(abortError));
        return true;
      }

      try {
        agent.send(
          JSON.stringify({
            type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL,
            id: requestId
          })
        );
      } catch {
        // Ignore failures (e.g. agent already disconnected)
      }

      // Keep the ID so the shared message handler ignores in-flight chunks
      // until the server's terminal frame performs its normal cleanup.
      finish(() => readerController?.error(abortError), true);
      return true;
    };
    this._abortToolContinuation = abortToolContinuationRef;
    detachResumeStreamRef = () => {
      if (completed) return false;
      finish(() => readerController?.close());
      return true;
    };
    this._detachResumeStream = detachResumeStreamRef;

    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        readerController = controller;
        let timeout: ReturnType<typeof setTimeout> | undefined;

        const armTimeout = (delay: number) => {
          if (timeout) clearTimeout(timeout);
          timeout = setTimeout(() => finish(() => controller.close()), delay);
        };

        const onResumeNone = (data: { probeId?: string }) => {
          if (data.probeId && data.probeId !== probeId) return false;
          finish(() => controller.close());
          return true;
        };

        const onResume = (data: { id: string }) => {
          if (requestId) return;

          requestId = data.id;
          activeIds?.add(requestId);
          clearOwnedHandshake();
          if (timeout) clearTimeout(timeout);

          agent.send(
            JSON.stringify({
              type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
              id: requestId
            })
          );
        };

        const onStreamPending = () => {
          if (completed) return;
          armTimeout(RESUME_PENDING_TIMEOUT_MS);
        };

        const retryResumeProbe = () => {
          if (completed || requestId !== null) return;
          armTimeout(RESUME_PROBE_TIMEOUT_MS);
          try {
            transport.agent.send(
              JSON.stringify({
                type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST,
                probeId
              })
            );
          } catch {
            // A later socket open can retry this same deferred handshake.
          }
        };

        onResumeRef = onResume;
        onResumeNoneRef = onResumeNone;
        onStreamPendingRef = onStreamPending;
        retryResumeProbeRef = retryResumeProbe;
        transport._resumeResolver = onResume;
        transport._resumeNoneResolver = onResumeNone;
        transport._onStreamPending = onStreamPending;
        transport._retryResumeProbe = retryResumeProbe;

        const onMessage = (event: MessageEvent) => {
          try {
            const data = JSON.parse(
              event.data as string
            ) as OutgoingMessage<UIMessage>;

            if (
              data.type !== MessageType.CF_AGENT_USE_CHAT_RESPONSE ||
              requestId == null ||
              data.id !== requestId
            ) {
              return;
            }

            if (data.error) {
              finish(() =>
                controller.error(new Error(data.body || "Stream error"))
              );
              return;
            }

            if (data.body?.trim()) {
              try {
                const chunk = JSON.parse(data.body) as UIMessageChunk;
                controller.enqueue(chunk);
              } catch {
                // Skip malformed chunk bodies
              }
            }

            if (data.done) {
              finish(() => controller.close());
            }
          } catch {
            // Ignore non-JSON messages
          }
        };

        const onClose = () => finish(() => controller.close());

        agent.addEventListener("message", onMessage, {
          signal: streamController.signal
        });
        agent.addEventListener("close", onClose, {
          signal: streamController.signal
        });

        retryResumeProbe();
      },
      cancel() {
        if (requestId && transport.cancelOnClientAbort) {
          transport.sendCancelFrame(requestId);
          finish(() => {}, true);
        } else {
          finish(() => {});
        }
      }
    });
  }

  /**
   * Creates a ReadableStream that receives resumed stream chunks
   * and forwards them to useChat as UIMessageChunk objects.
   */
  private _createResumeStream(
    requestId: string
  ): ReadableStream<UIMessageChunk> {
    // Read agent at resolve time (not when reconnectToStream was called)
    // so chunk listener attaches to the latest socket after _pk changes.
    const agent = this.agent;
    const activeIds = this.activeRequestIds;
    const chunkController = new AbortController();
    const abortError = new Error("Aborted");
    abortError.name = "AbortError";
    let completed = false;
    let detachResumeStream: (() => boolean) | null = null;

    const finish = (
      action: () => void,
      keepId = false,
      clearServerTurn = true
    ) => {
      if (completed) return;
      completed = true;
      if (clearServerTurn) {
        this.clearActiveServerTurn(requestId);
      }
      if (this._detachResumeStream === detachResumeStream) {
        this._detachResumeStream = null;
      }
      try {
        action();
      } catch {
        // Stream may already be closed
      }
      if (!keepId) {
        activeIds?.delete(requestId);
      }
      chunkController.abort();
    };

    let streamController: ReadableStreamDefaultController<UIMessageChunk> | null =
      null;
    const cancelActiveRequest = () => {
      if (completed) return false;
      finish(() => streamController?.error(abortError), true);
      return true;
    };
    this.setActiveServerTurn(requestId, cancelActiveRequest);

    const transport = this;
    detachResumeStream = () => {
      if (completed) return false;
      finish(() => streamController?.close());
      return true;
    };
    this._detachResumeStream = detachResumeStream;

    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        streamController = controller;

        const onMessage = (event: MessageEvent) => {
          try {
            const data = JSON.parse(
              event.data as string
            ) as OutgoingMessage<UIMessage>;

            if (data.type !== MessageType.CF_AGENT_USE_CHAT_RESPONSE) return;
            if (data.id !== requestId) return;

            if (data.error) {
              finish(() =>
                controller.error(new Error(data.body || "Stream error"))
              );
              return;
            }

            // Parse and enqueue the chunk
            if (data.body?.trim()) {
              try {
                const chunk = JSON.parse(data.body) as UIMessageChunk;
                controller.enqueue(chunk);
              } catch {
                // Skip malformed chunk bodies
              }
            }

            if (data.done) {
              finish(() => controller.close());
            }
          } catch {
            // Ignore non-JSON messages
          }
        };

        const onClose = () => {
          finish(() => controller.close(), false, false);
        };

        agent.addEventListener("message", onMessage, {
          signal: chunkController.signal
        });
        agent.addEventListener("close", onClose, {
          signal: chunkController.signal
        });
      },
      cancel() {
        if (transport.cancelOnClientAbort) {
          transport.sendCancelFrame(requestId);
          finish(() => {}, true);
        } else {
          finish(() => {}, false, false);
        }
      }
    });
  }
}
