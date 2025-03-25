import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type JSONRPCMessage,
  JSONRPCMessageSchema,
} from "@modelcontextprotocol/sdk/types.js";

export class HTTPClientTransport implements Transport {
  sessionId?: string | undefined;
  #isStarted = false;
  #baseUrl: URL;

  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: ((message: JSONRPCMessage) => void) | undefined;

  constructor(baseUrl: URL) {
    this.#baseUrl = baseUrl;
    // Generate a unique session ID
    this.sessionId = crypto.randomUUID();
  }

  async start(): Promise<void> {
    if (this.#isStarted) {
      return;
    }
    this.#isStarted = true;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.#isStarted) {
      throw new Error("Transport not started");
    }

    try {
      const response = await fetch(this.#baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": this.sessionId ?? "",
        },
        body: JSON.stringify(message),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      if (Array.isArray(data)) {
        for (const msg of data) {
          const messageResult = JSONRPCMessageSchema.safeParse(msg);
          if (!messageResult.success) {
            throw Error(messageResult.error.message);
          }
          this.onmessage?.(messageResult.data);
        }
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.onerror?.(err);
      throw err;
    }
  }

  async close(): Promise<void> {
    this.#isStarted = false;
    this.onclose?.();
  }
}

type HTTPServerTransportOpts = {
  receive: () => Request | Promise<Request>;
  transmit: (response: Response) => void | Promise<void>;
};

export class HTTPServerTransport implements Transport {
  sessionId?: string | undefined;
  #isStarted = false;
  #messageBuffer: JSONRPCMessage[] = [];

  #receive: HTTPServerTransportOpts["receive"];
  #transmit: HTTPServerTransportOpts["transmit"];

  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: ((message: JSONRPCMessage) => void) | undefined;

  constructor(opts: HTTPServerTransportOpts) {
    const { receive, transmit } = opts;
    this.#receive = receive;
    this.#transmit = transmit;

    // Generate a unique session ID
    this.sessionId = crypto.randomUUID();
  }

  async start(): Promise<void> {
    if (this.#isStarted) {
      return;
    }
    this.#isStarted = true;
    const request = await this.#receive();
    if (request.method !== "POST") {
      this.#transmit(new Response("Method not allowed", { status: 405 }));
      return;
    }

    // Parse incoming JSON-RPC message
    const messageResult = JSONRPCMessageSchema.safeParse(await request.json());
    if (!messageResult.success) {
      const err = Error(messageResult.error.message);
      this.onerror?.(err);
      this.#transmit(new Response(err.message, { status: 405 }));
      return;
    }

    const message = messageResult.data;
    // Trigger onmessage handler
    this.onmessage?.(message);
    // After processing the message, queue the closure of the transport to finalize transmitting responses
    this.close();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.#isStarted) {
      throw new Error("Transport not started");
    }
    this.#messageBuffer.push(message);
  }

  async close(): Promise<void> {
    // Return any pending messages
    await this.#toolResponse();
    const response: JSONRPCMessage[] = [...this.#messageBuffer];

    this.#messageBuffer = [];
    this.#isStarted = false;
    this.onclose?.();

    this.#transmit(
      new Response(JSON.stringify(response), {
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": this.sessionId ?? "",
        },
      }),
    );
  }

  async #toolResponse() {
    while (this.#messageBuffer.length === 0) {
      await new Promise((resolve) =>
        setTimeout(() => {
          resolve(undefined);
        }, 0),
      );
    }
  }
}

