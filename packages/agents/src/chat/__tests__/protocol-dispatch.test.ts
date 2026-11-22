import { describe, expect, it } from "vitest";
import type { Connection } from "agents";
import type { ChatTurns } from "../chat-turns";
import { CHAT_MESSAGE_TYPES } from "../protocol";
import {
  recentChatTerminal,
  recordRecentChatTerminal
} from "../recent-terminals";
import {
  dispatchChatProtocol,
  parseChatRequest,
  rejectionMessage,
  releaseChatConnection,
  type ChatProtocolHost
} from "../protocol-dispatch";
import type { ChatRequestContext } from "../request-context";
import type { ResumeHandshake } from "../resume-handshake";

type Call = [string, ...unknown[]];

/** A host that records every call, with fakes for the core parts it uses. */
function recordingHost() {
  const calls: Call[] = [];
  const turns = {
    cancel: async (id: string) => {
      calls.push(["turns.cancel", id]);
    },
    cancelWaitingContinuation: (connectionId: string) => {
      calls.push(["turns.cancelWaitingContinuation", connectionId]);
    },
    applyInteraction: async (
      apply: () => Promise<unknown>,
      autoContinue: boolean,
      spec: () => unknown,
      enqueue: (run: () => Promise<boolean>) => Promise<boolean>,
      connectionId: string
    ) => {
      const outcome = await apply();
      calls.push([
        "turns.applyInteraction",
        outcome,
        autoContinue,
        spec(),
        connectionId
      ]);
      await enqueue(async () => true);
      return true;
    },
    continuation: {
      releaseConnection: (id: string) => {
        calls.push(["continuation.releaseConnection", id]);
      }
    },
    preStream: {
      release: (id: string) => {
        calls.push(["preStream.release", id]);
      }
    }
  };
  const requestContext = {
    applyingToolResult:
      (clientTools: unknown, apply: () => Promise<unknown>) => async () => {
        calls.push(["requestContext.applyingToolResult", clientTools]);
        return apply();
      }
  };
  const handshake = {
    handleResumeRequest: async (
      connection: Connection,
      probeId?: string,
      requestIds?: string[]
    ) => {
      calls.push(["resume.request", connection.id, probeId, requestIds]);
    },
    handleResumeAck: async (connection: Connection, id: string) => {
      calls.push(["resume.ack", connection.id, id]);
    }
  };
  const stored = new Map<string, unknown>();
  const terminals = {
    get: <T>(key: string) => stored.get(key) as T | undefined,
    put: <T>(key: string, value: T) => {
      stored.set(key, value);
    }
  };
  const host: ChatProtocolHost<Connection> = {
    // SAFETY: the dispatch reaches only the members the fakes implement.
    turns: turns as unknown as ChatTurns<Connection>,
    requestContext: requestContext as unknown as ChatRequestContext,
    resumeHandshake: () => handshake as unknown as ResumeHandshake,
    emit: (type, payload) => calls.push(["emit", type, payload]),
    chatRequest: async (connection, request) => {
      calls.push(["chatRequest", connection.id, request]);
    },
    frames: {
      send: (target, frame) => {
        target.send(JSON.stringify(frame));
        recordRecentChatTerminal(terminals, frame);
      }
    },
    rejectedChatRequest: (connection, rejection) => {
      calls.push([
        "rejectedChatRequest",
        connection.id,
        rejection.requestId,
        rejection.reason
      ]);
      return rejectionMessage(rejection);
    },
    clear: async (connection) => {
      calls.push(["clear", connection.id]);
    },
    messages: async (connection, messages) => {
      calls.push(["messages", connection.id, messages]);
    },
    applyToolResult: async (event) => {
      calls.push(["applyToolResult", event.toolCallId]);
      return { status: "changed", messageId: "a1" };
    },
    applyToolApproval: async (event) => {
      calls.push(["applyToolApproval", event.toolCallId, event.approved]);
      return { status: "unchanged" };
    },
    continuation: (connection, answer) => ({ connection, errorPrefix: answer }),
    enqueueInteraction: async (run) => {
      calls.push(["enqueueInteraction"]);
      return run();
    }
  };
  return { host, calls, terminals };
}

const sent: string[] = [];
const connection = {
  id: "c1",
  send: (message: string) => sent.push(message)
} as unknown as Connection;

function send(message: Record<string, unknown>) {
  return JSON.stringify(message);
}

describe("parseChatRequest", () => {
  it("splits messages, client tools and trigger from the custom body", () => {
    expect(
      parseChatRequest(
        "r1",
        JSON.stringify({
          messages: [{ id: "u1", role: "user", parts: [] }],
          clientTools: [{ name: "pick" }],
          trigger: "regenerate-message",
          extra: 1
        })
      )
    ).toEqual({
      requestId: "r1",
      trigger: "regenerate-message",
      messages: [{ id: "u1", role: "user", parts: [] }],
      clientTools: [{ name: "pick" }],
      body: { extra: 1 }
    });
  });

  it("defaults the trigger to submit-message", () => {
    const parsed = parseChatRequest("r1", JSON.stringify({ messages: [] }));
    expect(parsed).toMatchObject({
      trigger: "submit-message",
      clientTools: undefined
    });
  });

  it("rejects a missing body, invalid JSON and a body without messages", () => {
    expect(parseChatRequest("r1", undefined)).toEqual({
      requestId: "r1",
      reason: "empty-body"
    });
    expect(parseChatRequest("r1", "")).toMatchObject({ reason: "empty-body" });
    const invalid = parseChatRequest("r1", "{nope");
    expect(invalid).toMatchObject({ reason: "invalid-json" });
    expect("error" in invalid && invalid.error).toBeInstanceOf(SyntaxError);
    expect(parseChatRequest("r1", JSON.stringify({ a: 1 }))).toMatchObject({
      reason: "invalid-messages"
    });
    expect(parseChatRequest("r1", "null")).toMatchObject({
      reason: "invalid-messages"
    });
  });

  it("gives every rejection an error text", () => {
    expect(rejectionMessage({ requestId: "r", reason: "empty-body" })).toBe(
      "Chat request has no body"
    );
    expect(
      rejectionMessage({ requestId: "r", reason: "invalid-messages" })
    ).toBe("Chat request body has no messages array");
    expect(
      rejectionMessage({
        requestId: "r",
        reason: "invalid-json",
        error: new SyntaxError("bad")
      })
    ).toBe("bad");
  });
});

describe("dispatchChatProtocol", () => {
  it("leaves non-protocol messages to the app", async () => {
    const { host, calls } = recordingHost();
    expect(await dispatchChatProtocol(connection, "hello", host)).toBe(false);
    expect(
      await dispatchChatProtocol(connection, send({ type: "mine" }), host)
    ).toBe(false);
    expect(
      await dispatchChatProtocol(connection, new ArrayBuffer(2), host)
    ).toBe(false);
    expect(calls).toEqual([]);
  });

  it("runs a POST chat request with its parsed body", async () => {
    const { host, calls } = recordingHost();
    const handled = await dispatchChatProtocol(
      connection,
      send({
        type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST,
        id: "r1",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [], custom: true })
        }
      }),
      host
    );
    expect(handled).toBe(true);
    expect(calls).toEqual([
      [
        "chatRequest",
        "c1",
        {
          requestId: "r1",
          trigger: "submit-message",
          messages: [],
          clientTools: undefined,
          body: { custom: true }
        }
      ]
    ]);
  });

  it("hands a chat request it cannot parse to the host as rejected", async () => {
    const { host, calls, terminals } = recordingHost();
    for (const body of [undefined, "{nope", JSON.stringify({})]) {
      expect(
        await dispatchChatProtocol(
          connection,
          send({
            type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST,
            id: "r1",
            init: { method: "POST", body }
          }),
          host
        )
      ).toBe(true);
    }
    expect(sent.splice(0).map((frame) => JSON.parse(frame))).toEqual([
      {
        type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
        id: "r1",
        body: "Chat request has no body",
        done: true,
        error: true
      },
      expect.objectContaining({ id: "r1", done: true, error: true }),
      {
        type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
        id: "r1",
        body: "Chat request body has no messages array",
        done: true,
        error: true
      }
    ]);
    // Recorded like every terminal (D111): a tab resuming by id gets it.
    expect(recentChatTerminal(terminals, ["r1"])).toMatchObject({
      requestId: "r1",
      error: true,
      body: "Chat request body has no messages array"
    });
    expect(calls).toEqual([
      ["rejectedChatRequest", "c1", "r1", "empty-body"],
      ["rejectedChatRequest", "c1", "r1", "invalid-json"],
      ["rejectedChatRequest", "c1", "r1", "invalid-messages"]
    ]);
  });

  it("sends and records the error text the host returns", async () => {
    const { host, terminals } = recordingHost();
    host.rejectedChatRequest = () => "the app's own words";
    await dispatchChatProtocol(
      connection,
      send({
        type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST,
        id: "r2",
        init: { method: "POST", body: "{nope" }
      }),
      host
    );
    expect(JSON.parse(sent.splice(0)[0])).toMatchObject({
      id: "r2",
      body: "the app's own words"
    });
    expect(recentChatTerminal(terminals, ["r2"])).toMatchObject({
      body: "the app's own words"
    });
  });

  it("drops a chat request that is not a POST", async () => {
    const { host, calls } = recordingHost();
    expect(
      await dispatchChatProtocol(
        connection,
        send({
          type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST,
          id: "r1",
          init: { method: "GET" }
        }),
        host
      )
    ).toBe(true);
    expect(calls).toEqual([]);
  });

  it("routes clear and a pushed transcript to the host", async () => {
    const { host, calls } = recordingHost();
    await dispatchChatProtocol(
      connection,
      send({ type: CHAT_MESSAGE_TYPES.CHAT_CLEAR }),
      host
    );
    await dispatchChatProtocol(
      connection,
      send({ type: CHAT_MESSAGE_TYPES.CHAT_MESSAGES, messages: [{ id: "m" }] }),
      host
    );
    expect(calls).toEqual([
      ["clear", "c1"],
      ["messages", "c1", [{ id: "m" }]]
    ]);
  });

  it("cancels a request in the turn core and reports it", async () => {
    const { host, calls } = recordingHost();
    await dispatchChatProtocol(
      connection,
      send({ type: CHAT_MESSAGE_TYPES.CHAT_REQUEST_CANCEL, id: "r1" }),
      host
    );
    expect(calls).toEqual([
      ["turns.cancel", "r1"],
      ["emit", "message:cancel", { requestId: "r1" }]
    ]);
  });

  it("stops the continuation a tab waits on by its connection", async () => {
    const { host, calls } = recordingHost();
    await dispatchChatProtocol(
      connection,
      send({
        type: CHAT_MESSAGE_TYPES.CHAT_REQUEST_CANCEL,
        continuation: true
      }),
      host
    );
    expect(calls).toEqual([["turns.cancelWaitingContinuation", "c1"]]);
  });

  it("passes resume requests and acks to the handshake", async () => {
    const { host, calls } = recordingHost();
    await dispatchChatProtocol(
      connection,
      send({
        type: CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST,
        probeId: "p",
        requestIds: ["r1"]
      }),
      host
    );
    await dispatchChatProtocol(
      connection,
      send({ type: CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK, id: "r1" }),
      host
    );
    expect(calls).toEqual([
      ["resume.request", "c1", "p", ["r1"]],
      ["resume.ack", "c1", "r1"]
    ]);
  });

  it("applies a tool result through the request context and the apply chain", async () => {
    const { host, calls } = recordingHost();
    await dispatchChatProtocol(
      connection,
      send({
        type: CHAT_MESSAGE_TYPES.TOOL_RESULT,
        toolCallId: "t1",
        toolName: "pick",
        output: 1,
        autoContinue: true,
        clientTools: [{ name: "pick" }]
      }),
      host
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([
      ["emit", "tool:result", { toolCallId: "t1", toolName: "pick" }],
      ["requestContext.applyingToolResult", [{ name: "pick" }]],
      ["applyToolResult", "t1"],
      [
        "turns.applyInteraction",
        { status: "changed", messageId: "a1" },
        true,
        { connection, errorPrefix: "tool-result" },
        "c1"
      ],
      ["enqueueInteraction"]
    ]);
  });

  it("applies a tool approval through the apply chain", async () => {
    const { host, calls } = recordingHost();
    await dispatchChatProtocol(
      connection,
      send({
        type: CHAT_MESSAGE_TYPES.TOOL_APPROVAL,
        toolCallId: "t1",
        approved: false
      }),
      host
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([
      ["emit", "tool:approval", { toolCallId: "t1", approved: false }],
      ["applyToolApproval", "t1", false],
      [
        "turns.applyInteraction",
        { status: "unchanged" },
        false,
        { connection, errorPrefix: "tool-approval" },
        "c1"
      ],
      ["enqueueInteraction"]
    ]);
  });
});

describe("releaseChatConnection", () => {
  it("releases the resume offer, the continuation wait and a parked turn", () => {
    const { host, calls } = recordingHost();
    const pending = new Set(["c1", "c2"]);
    releaseChatConnection(host.turns, pending, "c1");
    expect([...pending]).toEqual(["c2"]);
    expect(calls).toEqual([
      ["continuation.releaseConnection", "c1"],
      ["preStream.release", "c1"]
    ]);
  });
});
