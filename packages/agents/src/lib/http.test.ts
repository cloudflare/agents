import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { HTTPClientTransport, HTTPServerTransport } from "./http";
import {
  JSONRPCResponseSchema,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";

describe("HTTPClientTransport", () => {
  let clientTransport: HTTPClientTransport;
  const baseUrl = new URL("http://localhost:3000");

  beforeEach(() => {
    // Mock crypto.randomUUID
    vi.spyOn(crypto, "randomUUID").mockReturnValue("test-session-id");
    clientTransport = new HTTPClientTransport(baseUrl);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should initialize with a session ID", () => {
    expect(clientTransport.sessionId).toBe("test-session-id");
  });

  it("should throw error when sending message before starting", async () => {
    const message: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "test",
      id: "1",
    };

    await expect(clientTransport.send(message)).rejects.toThrow(
      "Transport not started"
    );
  });

  it("should successfully send and receive messages", async () => {
    const mockResponse: JSONRPCMessage[] = [
      {
        result: { content: [{ type: "text", text: "880" }] },
        jsonrpc: "2.0",
        id: 1,
      },
    ];

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const onMessageMock = vi.fn();
    clientTransport.onmessage = onMessageMock;

    await clientTransport.start();
    await clientTransport.send({
      jsonrpc: "2.0",
      method: "test",
      id: "1",
    });

    expect(fetch).toHaveBeenCalledWith(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": "test-session-id",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "test",
        id: "1",
      }),
    });

    expect(onMessageMock).toHaveBeenCalledWith(mockResponse[0]);
  });

  it("should handle HTTP errors", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const onErrorMock = vi.fn();
    clientTransport.onerror = onErrorMock;

    await clientTransport.start();
    await expect(
      clientTransport.send({
        jsonrpc: "2.0",
        method: "test",
        id: "1",
      })
    ).rejects.toThrow("HTTP error! status: 500");

    expect(onErrorMock).toHaveBeenCalled();
  });
});

describe("HTTPServerTransport", () => {
  let request: Request;
  let transport: HTTPServerTransport;
  const responseMap = new WeakMap<Request, Response>();

  const createRequest = (opts: {
    method: string;
    body?: JSONRPCMessage | string;
  }) => {
    const request = new Request("http://localhost", {
      method: opts.method,
      ...(opts.body && { body: JSON.stringify(opts.body) }),
    });
    return request;
  };

  const transmitResponse = (request: Request) => async (response: Response) => {
    responseMap.set(request, response);
  };

  const receiveRequest = (request: Request) => async () => request;

  beforeEach(() => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("test-server-session-id");
    request = createRequest({ method: "GET" });
    transport = new HTTPServerTransport({
      receive: receiveRequest(request),
      transmit: transmitResponse(request),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should initialize with a session ID", () => {
    expect(transport.sessionId).toBe("test-server-session-id");
  });

  it("should handle invalid HTTP methods", async () => {
    await transport.start();
    const response = responseMap.get(request);

    expect(response?.status).toBe(405);
    expect(await response?.text()).toBe("Method not allowed");
  });

  it("should handle requests when transport is not started", async () => {
    const message: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "test",
      id: "1",
    };
    expect(async () => await transport.send(message)).rejects.toThrowError(
      new Error("Transport not started")
    );
  });

  it("should process valid JSON-RPC messages", async () => {
    const message: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "test",
      id: "1",
    };

    request = createRequest({
      method: "POST",
      body: message,
    });

    transport = new HTTPServerTransport({
      receive: receiveRequest(request),
      transmit: transmitResponse(request),
    });

    const onMessageMock = vi.fn();
    transport.onmessage = onMessageMock;

    await transport.start();

    // Simulate a response that will be sent back
    const responseMessage: JSONRPCMessage = {
      jsonrpc: "2.0",
      id: "1",
      result: { content: [{ type: "text", text: "Response" }] },
    };
    await transport.send(responseMessage);

    await _transport(request);
    const response = responseMap.get(request);

    expect(response?.status).toBe(200);
    expect(onMessageMock).toHaveBeenCalledWith(message);

    const responseBody = await response?.json();
    expect(responseBody).toEqual([responseMessage]);
    expect(response?.headers.get("X-Session-Id")).toBe(
      "test-server-session-id"
    );
  });

  it("should handle invalid JSON-RPC messages", async () => {
    request = createRequest({
      method: "POST",
      body: "Invalid",
    });

    transport = new HTTPServerTransport({
      receive: receiveRequest(request),
      transmit: transmitResponse(request),
    });

    await transport.start();
    const response = responseMap.get(request);

    expect(response?.status).toBe(405);
  });

  it("should wait for pending messages before responding", async () => {
    const message: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "test",
      id: "1",
    };

    request = createRequest({
      method: "POST",
      body: message,
    });

    transport = new HTTPServerTransport({
      receive: receiveRequest(request),
      transmit: transmitResponse(request),
    });

    await transport.start();

    // Simulate delayed response
    setTimeout(() => {
      transport.send({
        jsonrpc: "2.0",
        id: "1",
        result: { content: [{ type: "text", text: "Delayed" }] },
      });
    }, 100);

    const startTime = Date.now();
    await _transport(request);
    const response = responseMap.get(request);
    const endTime = Date.now();

    const responseBody = JSONRPCResponseSchema.array().parse(
      await response?.json()
    );

    expect(endTime - startTime).toBeGreaterThanOrEqual(100);
    expect(responseBody).toHaveLength(1);
    expect(responseBody?.[0]?.result).toMatchObject({
      content: [{ type: "text", text: "Delayed" }],
    });
  });

  it("should clear pending messages on close", async () => {
    const message: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "test",
      id: "1",
    };

    request = createRequest({
      method: "POST",
      body: message,
    });

    transport = new HTTPServerTransport({
      receive: receiveRequest(request),
      transmit: transmitResponse(request),
    });

    await transport.start();
    await transport.send({
      jsonrpc: "2.0",
      id: "1",
      result: { content: [{ type: "text", text: "Delayed" }] },
    });

    const onCloseMock = vi.fn();
    transport.onclose = onCloseMock;

    await transport.close();

    const response = responseMap.get(request);

    expect(response?.status).toBe(200);
    expect(onCloseMock).toHaveBeenCalled();
  });

  async function _transport(request: Request, max = 1000) {
    let tries = 0;
    while (!responseMap.has(request) && tries < max) {
      await new Promise((resolve) =>
        setTimeout(() => {
          ++tries;
          resolve(undefined);
        }, 0)
      );
    }
    const response = responseMap.get(request);
    if (!response) {
      return new Response("Server didn't respond in time", { status: 503 });
    }
    return response;
  }
});
