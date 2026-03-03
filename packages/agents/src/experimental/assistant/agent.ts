/**
 * AssistantAgent — an opinionated Agent base class for assistant use cases.
 *
 * Uses SessionManager as the sole persistence layer (no dual persistence).
 * Speaks the same WebSocket protocol as @cloudflare/ai-chat so the
 * useAgentChat React hook works unchanged on the client.
 *
 * Key differences from AIChatAgent:
 *   - SessionManager is the single source of truth for messages
 *   - Sessions are first-class (create, switch, list, delete, rename)
 *   - No resumable streams (yet)
 *   - No client-side tool protocol (server-side tools only)
 *   - No message reconciliation (server is authoritative)
 */

import type { LanguageModel, ModelMessage, ToolSet, UIMessage } from "ai";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText
} from "ai";
import {
  Agent,
  __DO_NOT_USE_WILL_BREAK__agentContext as agentContext
} from "../../index";
import type { AgentContext, Connection, WSMessage } from "../../index";
import { SessionManager } from "./session/index";
import type { Session } from "./session/index";
import { applyChunkToParts } from "./message-builder";
import type { StreamChunkData } from "./message-builder";

// ── Wire protocol constants ────────────────────────────────────────
// These string values are wire-compatible with @cloudflare/ai-chat's
// MessageType enum. Defined locally to avoid a circular dependency.
const MSG_CHAT_MESSAGES = "cf_agent_chat_messages";
const MSG_CHAT_REQUEST = "cf_agent_use_chat_request";
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";
const MSG_CHAT_CLEAR = "cf_agent_chat_clear";
const MSG_CHAT_CANCEL = "cf_agent_chat_request_cancel";

const decoder = new TextDecoder();

/**
 * Options passed to the onChatMessage handler.
 */
export interface ChatMessageOptions {
  /** Unique ID for this chat request */
  requestId: string;
  /** AbortSignal — fires when the client cancels */
  abortSignal?: AbortSignal;
}

// ── AssistantAgent ─────────────────────────────────────────────────

export class AssistantAgent<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown
> extends Agent<Env, State> {
  /** Session manager — the sole persistence layer for conversations. */
  sessions: SessionManager;

  /** In-memory messages for the current session. Authoritative after load. */
  messages: UIMessage[] = [];

  private _currentSessionId: string | null = null;
  private _abortControllers = new Map<string, AbortController>();

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.sessions = new SessionManager(this);
    this._recoverSession();
    this._setupProtocolHandlers();
  }

  // ── Override points ──────────────────────────────────────────────

  /**
   * Return the language model to use for inference.
   *
   * Must be overridden by subclasses that rely on the default
   * `onChatMessage` implementation (the agentic loop).
   *
   * @example
   * ```ts
   * import { createWorkersAI } from "workers-ai-provider";
   * getModel() {
   *   return createWorkersAI({ binding: this.env.AI })("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
   * }
   * ```
   */
  getModel(): LanguageModel {
    throw new Error(
      "Override getModel() to return a LanguageModel, or override onChatMessage() for full control."
    );
  }

  /**
   * Return the system prompt for the assistant.
   * Override to customize instructions, inject context files, etc.
   */
  getSystemPrompt(): string {
    return "You are a helpful assistant.";
  }

  /**
   * Return the tools available to the assistant.
   * Override to provide workspace tools, custom tools, MCP tools, etc.
   *
   * @example
   * ```ts
   * import { createWorkspaceTools } from "agents/experimental/assistant";
   * getTools() {
   *   return createWorkspaceTools(this.workspace);
   * }
   * ```
   */
  getTools(): ToolSet {
    return {};
  }

  /**
   * Return the maximum number of tool-call steps per turn.
   * The agentic loop will stop after this many rounds of
   * tool-call → execute → re-call.
   */
  getMaxSteps(): number {
    return 10;
  }

  /**
   * Assemble the model messages from the current conversation history.
   * Converts UIMessages to model messages and prunes older tool calls
   * and reasoning to keep context lean.
   *
   * Override to customize context assembly (e.g. inject memory,
   * project context files, or apply compaction).
   */
  async assembleContext(): Promise<ModelMessage[]> {
    return pruneMessages({
      messages: await convertToModelMessages(this.messages),
      toolCalls: "before-last-2-messages"
    });
  }

  /**
   * Handle an incoming chat message and generate a response.
   *
   * The default implementation runs the agentic loop:
   * 1. Assemble context from `this.messages`
   * 2. Call `streamText` with the model, system prompt, tools, and step limit
   * 3. Return the streaming response
   *
   * Override for full control over inference. When overriding, return a
   * Response (typically from `streamText().toUIMessageStreamResponse()`)
   * or undefined for no reply.
   *
   * When this is called, `this.messages` already contains the user's
   * latest messages persisted to the current session.
   */
  async onChatMessage(
    options?: ChatMessageOptions
  ): Promise<Response | undefined> {
    const result = streamText({
      model: this.getModel(),
      system: this.getSystemPrompt(),
      messages: await this.assembleContext(),
      tools: this.getTools(),
      stopWhen: stepCountIs(this.getMaxSteps()),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  // ── Session management ─────────────────────────────────────────

  getSessions(): Session[] {
    return this.sessions.list();
  }

  createSession(name: string): Session {
    const session = this.sessions.create(name);
    this._currentSessionId = session.id;
    this.messages = [];
    this._broadcastMessages();
    return session;
  }

  switchSession(sessionId: string): UIMessage[] {
    this._currentSessionId = sessionId;
    this.messages = this.sessions.getHistory(sessionId);
    this._broadcastMessages();
    return this.messages;
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    if (this._currentSessionId === sessionId) {
      this._currentSessionId = null;
      this.messages = [];
      this._broadcastMessages();
    }
  }

  renameSession(sessionId: string, name: string): void {
    this.sessions.rename(sessionId, name);
  }

  getCurrentSessionId(): string | null {
    return this._currentSessionId;
  }

  // ── Internals ───────────────────────────────────────────────────

  /**
   * Recover current session from the most recently updated session.
   * Called in the constructor to restore state after DO hibernation.
   */
  private _recoverSession() {
    const sessions = this.sessions.list();
    if (sessions.length > 0) {
      this._currentSessionId = sessions[0].id;
      this.messages = this.sessions.getHistory(this._currentSessionId);
    }
  }

  /**
   * Wrap onMessage and onRequest to intercept the chat protocol.
   * Unrecognized messages are forwarded to the user's handlers.
   */
  private _setupProtocolHandlers() {
    const _onMessage = this.onMessage.bind(this);
    this.onMessage = async (connection: Connection, message: WSMessage) => {
      if (typeof message === "string") {
        try {
          const data = JSON.parse(message) as Record<string, unknown>;
          if (await this._handleProtocol(connection, data)) return;
        } catch {
          // Not JSON — fall through to user handler
        }
      }
      return _onMessage(connection, message);
    };

    const _onRequest = this.onRequest.bind(this);
    this.onRequest = async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname.split("/").pop() === "get-messages") {
        return Response.json(this.messages);
      }
      return _onRequest(request);
    };
  }

  /**
   * Route an incoming WebSocket message to the appropriate handler.
   * Returns true if the message was handled by the protocol.
   */
  private async _handleProtocol(
    connection: Connection,
    data: Record<string, unknown>
  ): Promise<boolean> {
    const type = data.type as string;

    if (type === MSG_CHAT_REQUEST) {
      const init = data.init as { method?: string; body?: string } | undefined;
      if (init?.method === "POST") {
        await this._handleChatRequest(connection, data);
        return true;
      }
    }

    if (type === MSG_CHAT_CLEAR) {
      this._handleClear();
      return true;
    }

    if (type === MSG_CHAT_CANCEL) {
      this._handleCancel(data.id as string);
      return true;
    }

    return false;
  }

  /**
   * Handle CF_AGENT_USE_CHAT_REQUEST:
   * 1. Parse incoming messages
   * 2. Ensure a session exists
   * 3. Persist user messages to session
   * 4. Call onChatMessage
   * 5. Stream response back to clients
   * 6. Persist assistant message to session
   */
  private async _handleChatRequest(
    connection: Connection,
    data: Record<string, unknown>
  ) {
    const init = data.init as { body?: string };
    if (!init?.body) return;

    let parsed: { messages?: UIMessage[] };
    try {
      parsed = JSON.parse(init.body) as { messages?: UIMessage[] };
    } catch {
      return;
    }

    const incomingMessages = parsed.messages;
    if (!Array.isArray(incomingMessages)) return;

    // Ensure a session exists
    if (!this._currentSessionId) {
      const session = this.sessions.create("New Chat");
      this._currentSessionId = session.id;
    }

    // Persist incoming messages to session (idempotent via INSERT OR IGNORE)
    this.sessions.appendAll(this._currentSessionId, incomingMessages);

    // Reload from session (authoritative)
    this.messages = this.sessions.getHistory(this._currentSessionId);

    // Broadcast updated messages to other connections
    this._broadcastMessages([connection.id]);

    // Set up abort controller
    const requestId = data.id as string;
    const abortController = new AbortController();
    this._abortControllers.set(requestId, abortController);

    try {
      const response = await agentContext.run(
        { agent: this, connection, request: undefined, email: undefined },
        () =>
          this.onChatMessage({
            requestId,
            abortSignal: abortController.signal
          })
      );

      if (response) {
        await this.keepAliveWhile(() =>
          this._streamResponse(requestId, response, abortController.signal)
        );
      } else {
        this._broadcast({
          type: MSG_CHAT_RESPONSE,
          id: requestId,
          body: "No response was generated.",
          done: true
        });
      }
    } catch (error) {
      this._broadcast({
        type: MSG_CHAT_RESPONSE,
        id: requestId,
        body: error instanceof Error ? error.message : "Error",
        done: true,
        error: true
      });
    } finally {
      this._abortControllers.delete(requestId);
    }
  }

  /**
   * Handle CF_AGENT_CHAT_CLEAR: abort streams, clear current session messages.
   */
  private _handleClear() {
    // Abort any in-progress streams
    for (const controller of this._abortControllers.values()) {
      controller.abort();
    }
    this._abortControllers.clear();

    // Clear messages from the current session (preserves the session itself)
    if (this._currentSessionId) {
      this.sessions.clearMessages(this._currentSessionId);
    }

    this.messages = [];
    this._broadcast({ type: MSG_CHAT_CLEAR });
  }

  /**
   * Handle CF_AGENT_CHAT_REQUEST_CANCEL: abort a specific request.
   */
  private _handleCancel(requestId: string) {
    const controller = this._abortControllers.get(requestId);
    if (controller) {
      controller.abort();
    }
  }

  /**
   * Read a Response body (SSE or plain text), broadcast chunks to
   * clients, build a UIMessage, and persist it to the session.
   */
  private async _streamResponse(
    requestId: string,
    response: Response,
    abortSignal?: AbortSignal
  ) {
    if (!response.body) {
      this._broadcast({
        type: MSG_CHAT_RESPONSE,
        id: requestId,
        body: "",
        done: true
      });
      return;
    }

    const reader = response.body.getReader();
    const contentType = response.headers.get("content-type") || "";
    const isSSE = contentType.includes("text/event-stream");

    // Build assistant message from stream
    const message: UIMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: []
    };

    // Cancel reader on abort
    if (abortSignal && !abortSignal.aborted) {
      abortSignal.addEventListener(
        "abort",
        () => {
          reader.cancel().catch(() => {});
        },
        { once: true }
      );
    }

    let doneSent = false;

    try {
      if (isSSE) {
        doneSent = await this._readSSEStream(
          requestId,
          reader,
          message,
          abortSignal
        );
      } else {
        doneSent = await this._readPlainStream(
          requestId,
          reader,
          message,
          abortSignal
        );
      }
    } catch (error) {
      if (!doneSent) {
        this._broadcast({
          type: MSG_CHAT_RESPONSE,
          id: requestId,
          body: error instanceof Error ? error.message : "Stream error",
          done: true,
          error: true
        });
        doneSent = true;
      }
    } finally {
      reader.releaseLock();

      // Send done only if nothing above already sent it
      if (!doneSent) {
        this._broadcast({
          type: MSG_CHAT_RESPONSE,
          id: requestId,
          body: "",
          done: true
        });
      }
    }

    // Persist the assistant message to the session
    if (message.parts.length > 0 && this._currentSessionId) {
      this.sessions.append(this._currentSessionId, message);
      this.messages = this.sessions.getHistory(this._currentSessionId);
      this._broadcastMessages();
    }
  }

  /**
   * Read an AI SDK SSE stream, broadcasting chunks and building
   * the assistant message from parsed events. Returns true if a
   * "done" message was sent to the client (so callers don't double-send).
   */
  private async _readSSEStream(
    requestId: string,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    message: UIMessage,
    abortSignal?: AbortSignal
  ): Promise<boolean> {
    // Line buffer for handling partial reads across chunk boundaries
    let buffer = "";

    while (true) {
      if (abortSignal?.aborted) return false;

      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        return false;
      }
      const { done, value } = result;

      if (done) {
        // Process any remaining buffered data
        if (buffer.trim()) {
          this._processSSELine(requestId, buffer, message);
        }
        this._broadcast({
          type: MSG_CHAT_RESPONSE,
          id: requestId,
          body: "",
          done: true
        });
        return true;
      }

      // Append new data to buffer, then split into complete lines
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");

      // Last element may be incomplete — keep it in the buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        this._processSSELine(requestId, line, message);
      }
    }
  }

  /**
   * Process a single complete SSE line: parse the JSON payload,
   * update the UIMessage being built, and broadcast to clients.
   */
  private _processSSELine(requestId: string, line: string, message: UIMessage) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") return;

    let data: StreamChunkData;
    try {
      data = JSON.parse(line.slice(6)) as StreamChunkData;
    } catch {
      return; // skip malformed JSON
    }

    // Build UIMessage from stream events
    const handled = applyChunkToParts(message.parts, data);

    if (!handled) {
      // Handle events that applyChunkToParts doesn't cover
      switch (data.type) {
        case "start": {
          if (data.messageId != null) {
            message.id = data.messageId;
          }
          if (data.messageMetadata != null) {
            message.metadata = message.metadata
              ? { ...message.metadata, ...data.messageMetadata }
              : data.messageMetadata;
          }
          break;
        }
        case "finish":
        case "message-metadata": {
          if (data.messageMetadata != null) {
            message.metadata = message.metadata
              ? { ...message.metadata, ...data.messageMetadata }
              : data.messageMetadata;
          }
          break;
        }
        case "error": {
          this._broadcast({
            type: MSG_CHAT_RESPONSE,
            id: requestId,
            body: data.errorText ?? JSON.stringify(data),
            done: false,
            error: true
          });
          return;
        }
      }
    }

    // Convert internal finish events to valid UIMessageStreamPart format
    let eventToSend: unknown = data;
    if (data.type === "finish" && "finishReason" in data) {
      const { finishReason, ...rest } = data as unknown as {
        finishReason: string;
        [key: string]: unknown;
      };
      eventToSend = {
        ...rest,
        type: "finish",
        messageMetadata: { finishReason }
      };
    }

    // Broadcast chunk to clients
    this._broadcast({
      type: MSG_CHAT_RESPONSE,
      id: requestId,
      body: JSON.stringify(eventToSend),
      done: false
    });
  }

  /**
   * Read a plain text response stream, wrapping it in text-start/delta/end
   * events for the UI protocol. Returns true if stream completed normally.
   */
  private async _readPlainStream(
    requestId: string,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    message: UIMessage,
    abortSignal?: AbortSignal
  ): Promise<boolean> {
    // Inject text-start event
    const startEvent = { type: "text-start", id: requestId };
    applyChunkToParts(message.parts, startEvent);
    this._broadcast({
      type: MSG_CHAT_RESPONSE,
      id: requestId,
      body: JSON.stringify(startEvent),
      done: false
    });

    while (true) {
      if (abortSignal?.aborted) return false;

      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        return false;
      }
      const { done, value } = result;

      if (done) {
        const endEvent = { type: "text-end", id: requestId };
        applyChunkToParts(message.parts, endEvent);
        this._broadcast({
          type: MSG_CHAT_RESPONSE,
          id: requestId,
          body: JSON.stringify(endEvent),
          done: false
        });
        this._broadcast({
          type: MSG_CHAT_RESPONSE,
          id: requestId,
          body: "",
          done: true
        });
        return true;
      }

      const text = decoder.decode(value, { stream: true });
      if (text.length > 0) {
        const deltaEvent = {
          type: "text-delta",
          id: requestId,
          delta: text
        };
        applyChunkToParts(message.parts, deltaEvent);
        this._broadcast({
          type: MSG_CHAT_RESPONSE,
          id: requestId,
          body: JSON.stringify(deltaEvent),
          done: false
        });
      }
    }
  }

  /**
   * Broadcast a JSON message to all connected clients.
   */
  private _broadcast(message: Record<string, unknown>, exclude?: string[]) {
    this.broadcast(JSON.stringify(message), exclude);
  }

  /**
   * Broadcast the current message list to all connected clients.
   */
  private _broadcastMessages(exclude?: string[]) {
    this._broadcast(
      { type: MSG_CHAT_MESSAGES, messages: this.messages },
      exclude
    );
  }
}
