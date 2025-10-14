import type {
  Transport,
  TransportSendOptions
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  MessageExtraInfo
} from "@modelcontextprotocol/sdk/types.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

/**
 * Validates a JSON-RPC 2.0 batch request
 * @see JSON-RPC 2.0 spec section 6
 */
function validateJSONRPCBatch(batch: unknown): batch is JSONRPCMessage[] {
  if (!Array.isArray(batch)) {
    throw new Error("Invalid JSON-RPC batch: must be an array");
  }

  // Spec: "an Array with at least one value"
  if (batch.length === 0) {
    throw new Error("Invalid JSON-RPC batch: array must not be empty");
  }

  // Validate each message in the batch
  for (let i = 0; i < batch.length; i++) {
    try {
      validateJSONRPCMessage(batch[i]);
    } catch (error) {
      throw new Error(
        `Invalid JSON-RPC batch: message at index ${i} is invalid: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return true;
}

/**
 * Validates that a message conforms to JSON-RPC 2.0 specification
 * @see https://www.jsonrpc.org/specification
 * @see /packages/agents/src/mcp/json-rpc-spec.md
 */
function validateJSONRPCMessage(message: unknown): message is JSONRPCMessage {
  if (!message || typeof message !== "object") {
    throw new Error("Invalid JSON-RPC message: must be an object");
  }

  const msg = message as Record<string, unknown>;

  // Spec line 26: jsonrpc MUST be exactly "2.0"
  if (msg.jsonrpc !== "2.0") {
    throw new Error('Invalid JSON-RPC message: jsonrpc field must be "2.0"');
  }

  // Check if it's a request/notification (has method field)
  if ("method" in msg) {
    // Spec line 27-28: method MUST be a String
    if (typeof msg.method !== "string") {
      throw new Error("Invalid JSON-RPC request: method must be a string");
    }

    // Spec line 28: Method names starting with "rpc." are reserved
    if (msg.method.startsWith("rpc.")) {
      throw new Error(
        'Invalid JSON-RPC request: method names starting with "rpc." are reserved for internal methods'
      );
    }

    // Spec line 31-32: id MAY be omitted (notification), but if included MUST be String, Number, or NULL
    if (
      "id" in msg &&
      msg.id !== null &&
      typeof msg.id !== "string" &&
      typeof msg.id !== "number"
    ) {
      throw new Error(
        "Invalid JSON-RPC request: id must be string, number, or null"
      );
    }

    // Spec line 32: Warn about fractional numbers in id (SHOULD NOT have fractional parts)
    if (typeof msg.id === "number" && !Number.isInteger(msg.id)) {
      console.warn("JSON-RPC warning: id should not contain fractional parts");
    }

    // Spec line 29-30, 45-48: params MAY be omitted, but if present MUST be Array or Object (Structured value)
    if ("params" in msg && msg.params !== undefined) {
      const params = msg.params;
      if (params !== null && typeof params !== "object") {
        throw new Error(
          "Invalid JSON-RPC request: params must be an array or object"
        );
      }
      // params can be an object or array, but not other types
      if (
        params === null ||
        (typeof params === "object" &&
          !Array.isArray(params) &&
          Object.getPrototypeOf(params) !== Object.prototype)
      ) {
        throw new Error(
          "Invalid JSON-RPC request: params must be an array or object"
        );
      }
    }

    return true;
  }

  // Check if it's a response (has id but no method)
  if ("id" in msg) {
    // Spec line 63: id is REQUIRED in responses
    // Spec line 64-65: id MUST be same as request, or NULL on parse/invalid request error
    if (
      msg.id !== null &&
      typeof msg.id !== "string" &&
      typeof msg.id !== "number"
    ) {
      throw new Error(
        "Invalid JSON-RPC response: id must be string, number, or null"
      );
    }

    // Spec line 66: Either result or error MUST be included, but both MUST NOT be included
    const hasResult = "result" in msg;
    const hasError = "error" in msg;

    if (!hasResult && !hasError) {
      throw new Error(
        "Invalid JSON-RPC response: must have either result or error"
      );
    }

    if (hasResult && hasError) {
      throw new Error(
        "Invalid JSON-RPC response: cannot have both result and error"
      );
    }

    // Spec line 68-80: Validate error object structure if present
    if (hasError) {
      const error = msg.error as Record<string, unknown>;
      if (!error || typeof error !== "object") {
        throw new Error("Invalid JSON-RPC error: error must be an object");
      }
      // Spec line 71-73: code MUST be a Number (integer)
      if (typeof error.code !== "number") {
        throw new Error("Invalid JSON-RPC error: code must be a number");
      }
      if (!Number.isInteger(error.code)) {
        throw new Error("Invalid JSON-RPC error: code must be an integer");
      }
      // Spec line 74-76: message MUST be a String
      if (typeof error.message !== "string") {
        throw new Error("Invalid JSON-RPC error: message must be a string");
      }
      // Spec line 77-80: data MAY be omitted, but if present can be any Primitive or Structured value
      // (no validation needed - any type is allowed)
    }

    return true;
  }

  throw new Error(
    "Invalid JSON-RPC message: must have either method (request/notification) or id (response)"
  );
}

export interface MCPStub {
  handleMcpMessage(
    message: JSONRPCMessage | JSONRPCMessage[]
  ): Promise<JSONRPCMessage | JSONRPCMessage[] | undefined>;
}

export interface RPCClientTransportOptions {
  stub: MCPStub;
  functionName?: string;
}

export class RPCClientTransport implements Transport {
  private _stub: MCPStub;
  private _functionName: string;
  private _started = false;
  private _protocolVersion?: string;

  sessionId?: string;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  constructor(options: RPCClientTransportOptions) {
    this._stub = options.stub;
    this._functionName = options.functionName ?? "handleMcpMessage";
  }

  setProtocolVersion(version: string): void {
    this._protocolVersion = version;
  }

  getProtocolVersion(): string | undefined {
    return this._protocolVersion;
  }

  async start(): Promise<void> {
    if (this._started) {
      throw new Error("Transport already started");
    }
    this._started = true;
  }

  async close(): Promise<void> {
    this._started = false;
    this.onclose?.();
  }

  async send(
    message: JSONRPCMessage | JSONRPCMessage[],
    options?: TransportSendOptions
  ): Promise<void> {
    if (!this._started) {
      throw new Error("Transport not started");
    }

    // Validate batch or single message
    if (Array.isArray(message)) {
      validateJSONRPCBatch(message);
    } else {
      validateJSONRPCMessage(message);
    }

    try {
      const result =
        await this._stub[this._functionName as keyof MCPStub](message);

      if (!result) {
        return;
      }

      // Prepare MessageExtraInfo if relatedRequestId is provided
      const extra: MessageExtraInfo | undefined = options?.relatedRequestId
        ? { requestInfo: { headers: {} } }
        : undefined;

      if (Array.isArray(result)) {
        for (const msg of result) {
          validateJSONRPCMessage(msg);
          this.onmessage?.(msg, extra);
        }
      } else {
        validateJSONRPCMessage(result);
        this.onmessage?.(result, extra);
      }
    } catch (error) {
      this.onerror?.(error as Error);
      throw error;
    }
  }
}

/**
 * Configuration options for RPCServerTransport
 *
 * Session Management:
 * - Stateless mode (default): No sessionIdGenerator provided. All requests are accepted without validation.
 * - Stateful mode: When sessionIdGenerator is provided, the server enforces session initialization.
 *   - Clients must send an initialize request first to establish a session
 *   - All subsequent requests are validated to ensure session is initialized
 *   - Session ID is generated during initialization and available via transport.sessionId
 */
export interface RPCServerTransportOptions {
  /**
   * Function that generates a session ID for the transport.
   * The session ID SHOULD be globally unique and cryptographically secure (e.g., a securely generated UUID, a JWT, or a cryptographic hash)
   *
   * When provided, enables stateful session management:
   * - Session is created during MCP initialization request
   * - Non-initialization requests will be rejected until session is initialized
   * - Session can be terminated via terminateSession() or transport.close()
   *
   * When omitted, transport operates in stateless mode (no session validation).
   */
  sessionIdGenerator?: (() => string) | undefined;

  /**
   * A callback for session initialization events.
   * Called after a session ID is generated during MCP initialization.
   *
   * @param sessionId The generated session ID
   *
   * @example
   * ```typescript
   * const transport = new RPCServerTransport({
   *   sessionIdGenerator: () => crypto.randomUUID(),
   *   onsessioninitialized: async (sessionId) => {
   *     console.log(`Session ${sessionId} initialized`);
   *     await database.createSession(sessionId);
   *   }
   * });
   * ```
   */
  onsessioninitialized?: (sessionId: string) => void | Promise<void>;

  /**
   * A callback for session close events.
   * Called when the session is terminated via terminateSession() or transport.close().
   *
   * @param sessionId The session ID that was closed
   *
   * @example
   * ```typescript
   * const transport = new RPCServerTransport({
   *   sessionIdGenerator: () => crypto.randomUUID(),
   *   onsessionclosed: async (sessionId) => {
   *     console.log(`Session ${sessionId} closed`);
   *     await database.deleteSession(sessionId);
   *   }
   * });
   * ```
   */
  onsessionclosed?: (sessionId: string) => void | Promise<void>;
}

export class RPCServerTransport implements Transport {
  private _started = false;
  private _pendingResponse: JSONRPCMessage | JSONRPCMessage[] | null = null;
  private _responseResolver: (() => void) | null = null;
  private _currentRequestId: string | number | null = null;
  private _protocolVersion?: string;
  private _sessionIdGenerator: (() => string) | undefined;
  private _initialized = false;
  private _onsessioninitialized?: (sessionId: string) => void | Promise<void>;
  private _onsessionclosed?: (sessionId: string) => void | Promise<void>;

  sessionId?: string;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  constructor(options?: RPCServerTransportOptions) {
    this._sessionIdGenerator = options?.sessionIdGenerator;
    this._onsessioninitialized = options?.onsessioninitialized;
    this._onsessionclosed = options?.onsessionclosed;
  }

  setProtocolVersion(version: string): void {
    this._protocolVersion = version;
  }

  getProtocolVersion(): string | undefined {
    return this._protocolVersion;
  }

  async start(): Promise<void> {
    if (this._started) {
      throw new Error("Transport already started");
    }
    this._started = true;
  }

  async close(): Promise<void> {
    this._started = false;

    // Terminate session if it exists
    await this.terminateSession();

    this.onclose?.();
    // Resolve any pending response promises
    if (this._responseResolver) {
      this._responseResolver();
      this._responseResolver = null;
    }
    this._currentRequestId = null;
  }

  async send(
    message: JSONRPCMessage,
    _options?: TransportSendOptions
  ): Promise<void> {
    if (!this._started) {
      throw new Error("Transport not started");
    }

    validateJSONRPCMessage(message);

    // Validate response IDs match the request ID (JSON-RPC 2.0 spec section 5)
    const isResponse = "id" in message && !("method" in message);
    if (isResponse && this._currentRequestId !== null) {
      const responseId = (message as { id: string | number | null }).id;
      if (responseId !== this._currentRequestId) {
        throw new Error(
          `Response ID ${responseId} does not match request ID ${this._currentRequestId} (JSON-RPC 2.0 spec section 5)`
        );
      }
    }

    if (!this._pendingResponse) {
      this._pendingResponse = message;
    } else if (Array.isArray(this._pendingResponse)) {
      this._pendingResponse.push(message);
    } else {
      this._pendingResponse = [this._pendingResponse, message];
    }

    // Resolve the promise on the next tick to allow multiple sends to accumulate
    if (this._responseResolver) {
      const resolver = this._responseResolver;
      this._responseResolver = null;
      // Use queueMicrotask to allow additional send() calls to accumulate
      queueMicrotask(() => resolver());
    }
  }

  /**
   * Validates that the session is initialized for non-initialization requests
   */
  private _validateSession(message: JSONRPCMessage): void {
    // If we're in stateless mode (no session ID generator), skip validation
    if (!this._sessionIdGenerator) {
      return;
    }

    // If this is an initialization request, don't validate session yet
    if (isInitializeRequest(message)) {
      return;
    }

    // For all other requests, ensure the session is initialized
    if (!this._initialized) {
      throw new Error(
        "Session not initialized. An initialize request must be sent first."
      );
    }
  }

  /**
   * Terminates the current session and calls the session closed callback
   */
  async terminateSession(): Promise<void> {
    if (this.sessionId && this._onsessionclosed) {
      await this._onsessionclosed(this.sessionId);
    }
    this._initialized = false;
    this.sessionId = undefined;
  }

  async handle(
    message: JSONRPCMessage | JSONRPCMessage[]
  ): Promise<JSONRPCMessage | JSONRPCMessage[] | undefined> {
    if (!this._started) {
      throw new Error("Transport not started");
    }

    // Handle batch requests (JSON-RPC 2.0 spec section 6)
    if (Array.isArray(message)) {
      validateJSONRPCBatch(message);

      const responses: JSONRPCMessage[] = [];

      // Process each message in the batch
      for (const msg of message) {
        const response = await this.handle(msg);
        // Spec: "A Response object SHOULD exist for each Request object,
        // except that there SHOULD NOT be any Response objects for notifications"
        if (response !== undefined) {
          if (Array.isArray(response)) {
            responses.push(...response);
          } else {
            responses.push(response);
          }
        }
      }

      // Spec: "If there are no Response objects contained within the Response array
      // as it is to be sent to the client, the server MUST NOT return an empty Array
      // and should return nothing at all"
      if (responses.length === 0) {
        return undefined;
      }

      return responses;
    }

    // Handle single message
    validateJSONRPCMessage(message);

    // Session management: validate session for non-initialization requests
    this._validateSession(message);

    // Session management: handle initialization requests
    if (isInitializeRequest(message) && this._sessionIdGenerator) {
      if (this._initialized) {
        throw new Error("Session already initialized");
      }

      // Generate session ID
      this.sessionId = this._sessionIdGenerator();
      this._initialized = true;

      // Call session initialized callback
      if (this._onsessioninitialized) {
        await this._onsessioninitialized(this.sessionId);
      }
    }

    this._pendingResponse = null;

    const isNotification = !("id" in message);
    if (isNotification) {
      // notifications do not get responses
      this.onmessage?.(message);
      return undefined;
    }

    // Store the request ID to validate responses (JSON-RPC 2.0 spec section 5)
    this._currentRequestId = (message as { id: string | number | null }).id;

    // Set up the promise before calling onmessage to handle race conditions
    const responsePromise = new Promise<void>((resolve) => {
      this._responseResolver = resolve;
    });

    this.onmessage?.(message);

    // Wait for a response using a promise that resolves when send() is called
    await responsePromise;

    const response = this._pendingResponse;
    this._pendingResponse = null;
    this._currentRequestId = null;

    return response ?? undefined;
  }
}
