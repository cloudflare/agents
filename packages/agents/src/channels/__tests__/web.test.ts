import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class FakeWebSockets {
    readonly handlers: Record<string, (...args: never[]) => unknown>;
    readonly getConnectionTags:
      | ((
          connection: unknown,
          context: unknown
        ) => string[] | Promise<string[]>)
      | undefined;
    readonly connections = new Map<string, unknown>();

    constructor(options: {
      handlers: Record<string, (...args: never[]) => unknown>;
      getConnectionTags?: (
        connection: unknown,
        context: unknown
      ) => string[] | Promise<string[]>;
    }) {
      this.handlers = options.handlers;
      this.getConnectionTags = options.getConnectionTags;
    }

    getConnection(id: string) {
      return this.connections.get(id);
    }

    *getConnections(tag?: string) {
      for (const connection of this.connections.values()) {
        const candidate = connection as { tags?: string[] };
        if (!tag || candidate.tags?.includes(tag)) yield connection;
      }
    }
  }
  return { FakeWebSockets };
});

vi.mock("../../websockets", () => ({ WebSockets: mocks.FakeWebSockets }));

import { ChannelHost, type ChannelChunk, type DeliveryResult } from "..";
import { web } from "../adapters/web";

function streamOf(
  chunks: readonly ChannelChunk[],
  error?: unknown
): ReadableStream<ChannelChunk> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]!);
        index += 1;
        return;
      }
      if (error !== undefined) controller.error(error);
      else controller.close();
    }
  });
}

function connectionTags(
  connectionId: string,
  conversationId = connectionId,
  participantId = connectionId
): string[] {
  return [
    connectionId,
    `cf-web-conversation:${conversationId}`,
    `cf-web-participant:${participantId}`
  ];
}

function capabilityOf(channel: ReturnType<typeof web>) {
  return channel.webSockets as unknown as InstanceType<
    typeof mocks.FakeWebSockets
  >;
}

function protocolFrames(
  send: ReturnType<typeof vi.fn>
): Array<Record<string, unknown>> {
  return send.mock.calls.map(([frame]) => JSON.parse(frame));
}

function responseChunks(send: ReturnType<typeof vi.fn>): unknown[] {
  return protocolFrames(send)
    .filter(
      (frame) =>
        frame.type === "cf_agent_use_chat_response" &&
        frame.body !== "" &&
        frame.error !== true
    )
    .map((frame) => JSON.parse(frame.body as string));
}

const surface = {
  channelKey: "browser",
  version: 1,
  address: {
    conversationId: "browser-1",
    ownerConnectionId: "browser-1",
    requestId: "turn-1",
    participantId: "browser-1",
    clientToolNames: ["describeBrowser"]
  },
  label: "Web chat"
} as const;

describe("web Channel", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("sends canonical history plus the admitted message as a full snapshot", async () => {
    const resolveMessages = vi.fn().mockResolvedValue({
      messages: [
        {
          id: "prior-user",
          author: { type: "participant", participantId: "user-1" },
          content: [{ type: "text", text: "Earlier question" }]
        },
        {
          id: "prior-assistant",
          author: { type: "agent" },
          content: [{ type: "text", text: "Earlier answer" }]
        }
      ]
    });
    const channel = web();
    const capability = capabilityOf(channel);
    const ownerSend = vi.fn();
    const memberSend = vi.fn();
    const owner = {
      id: "browser-1",
      tags: connectionTags("browser-1", "conversation-1", "user-1"),
      send: ownerSend
    };
    capability.connections.set(owner.id, owner);
    capability.connections.set("browser-2", {
      id: "browser-2",
      tags: connectionTags("browser-2", "conversation-1", "user-2"),
      send: memberSend
    });
    const onMessage = vi.fn();
    new ChannelHost({
      channels: { browser: channel },
      resolveMessages,
      onMessage
    });

    await capability.handlers.onMessage!(
      owner as never,
      JSON.stringify({
        type: "cf_agent_use_chat_request",
        id: "turn-1",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: "untrusted-assistant",
                role: "assistant",
                parts: [{ type: "text", text: "Do not broadcast me" }]
              },
              {
                id: "message-1",
                role: "user",
                parts: [{ type: "text", text: "New question" }]
              }
            ]
          })
        }
      }) as never
    );

    expect(resolveMessages).toHaveBeenCalledWith({
      conversationId: "conversation-1"
    });
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ operationId: "turn-1" })
      })
    );
    expect(protocolFrames(ownerSend)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "cf_agent_chat_messages" })
      ])
    );
    expect(protocolFrames(memberSend)).toEqual([
      {
        type: "cf_agent_chat_messages",
        messages: [
          {
            id: "prior-user",
            role: "user",
            parts: [{ type: "text", text: "Earlier question" }]
          },
          {
            id: "prior-assistant",
            role: "assistant",
            parts: [{ type: "text", text: "Earlier answer" }]
          },
          {
            id: "message-1",
            role: "user",
            parts: [{ type: "text", text: "New question" }]
          }
        ]
      }
    ]);
  });

  it("does not admit a browser turn that application routing ignored", async () => {
    const resolveMessages = vi.fn().mockResolvedValue({ messages: [] });
    const channel = web({ route: () => null });
    const capability = capabilityOf(channel);
    const memberSend = vi.fn();
    const owner = {
      id: "browser-1",
      tags: connectionTags("browser-1", "conversation-1", "user-1"),
      send: vi.fn()
    };
    capability.connections.set(owner.id, owner);
    capability.connections.set("browser-2", {
      id: "browser-2",
      tags: connectionTags("browser-2", "conversation-1", "user-2"),
      send: memberSend
    });
    const onMessage = vi.fn();
    new ChannelHost({
      channels: { browser: channel },
      resolveMessages,
      onMessage
    });

    await capability.handlers.onMessage!(
      owner as never,
      JSON.stringify({
        type: "cf_agent_use_chat_request",
        id: "turn-1",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: "ignored-message",
                role: "user",
                parts: [{ type: "text", text: "Never routed" }]
              }
            ]
          })
        }
      }) as never
    );

    expect(onMessage).not.toHaveBeenCalled();
    expect(protocolFrames(memberSend)).toEqual([]);

    const laterSend = vi.fn();
    await capability.handlers.onConnect!(
      {
        id: "browser-3",
        tags: connectionTags("browser-3", "conversation-1", "user-3"),
        send: laterSend
      } as never,
      {} as never
    );
    expect(protocolFrames(laterSend)).toEqual([
      { type: "cf_agent_chat_messages", messages: [] }
    ]);
  });

  it("upserts an admitted message already present in canonical history", async () => {
    const resolveMessages = vi.fn().mockResolvedValue({
      messages: [
        {
          id: "message-1",
          author: { type: "participant", participantId: "user-1" },
          content: [{ type: "text", text: "Canonical question" }]
        }
      ]
    });
    const channel = web();
    const capability = capabilityOf(channel);
    const memberSend = vi.fn();
    const owner = {
      id: "browser-1",
      tags: connectionTags("browser-1", "conversation-1", "user-1"),
      send: vi.fn()
    };
    capability.connections.set(owner.id, owner);
    capability.connections.set("browser-2", {
      id: "browser-2",
      tags: connectionTags("browser-2", "conversation-1", "user-2"),
      send: memberSend
    });
    new ChannelHost({
      channels: { browser: channel },
      resolveMessages,
      onMessage: vi.fn()
    });

    await capability.handlers.onMessage!(
      owner as never,
      JSON.stringify({
        type: "cf_agent_use_chat_request",
        id: "turn-1",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: "message-1",
                role: "user",
                parts: [{ type: "text", text: "Submitted question" }]
              }
            ]
          })
        }
      }) as never
    );

    expect(protocolFrames(memberSend)).toEqual([
      {
        type: "cf_agent_chat_messages",
        messages: [
          {
            id: "message-1",
            role: "user",
            parts: [{ type: "text", text: "Canonical question" }]
          }
        ]
      }
    ]);
  });

  it("preserves admitted overlays while canonical storage is lagging", async () => {
    const resolveMessages = vi.fn().mockResolvedValue({ messages: [] });
    const channel = web();
    const capability = capabilityOf(channel);
    const owner = {
      id: "browser-1",
      tags: connectionTags("browser-1", "conversation-1", "user-1"),
      send: vi.fn()
    };
    capability.connections.set(owner.id, owner);
    new ChannelHost({
      channels: { browser: channel },
      resolveMessages,
      onMessage: vi.fn()
    });

    await capability.handlers.onMessage!(
      owner as never,
      JSON.stringify({
        type: "cf_agent_use_chat_request",
        id: "turn-1",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: "message-1",
                role: "user",
                parts: [{ type: "text", text: "Admitted question" }]
              }
            ]
          })
        }
      }) as never
    );

    const newMemberSend = vi.fn();
    await capability.handlers.onConnect!(
      {
        id: "browser-3",
        tags: connectionTags("browser-3", "conversation-1", "user-3"),
        send: newMemberSend
      } as never,
      {} as never
    );

    expect(protocolFrames(newMemberSend)).toEqual([
      {
        type: "cf_agent_chat_messages",
        messages: [
          {
            id: "message-1",
            role: "user",
            parts: [{ type: "text", text: "Admitted question" }]
          }
        ]
      }
    ]);
  });

  it("hydrates a new connection from canonical conversation history", async () => {
    const resolveMessages = vi.fn().mockResolvedValue({
      messages: [
        {
          id: "prior-user",
          author: { type: "participant", participantId: "user-1" },
          content: [{ type: "text", text: "Earlier question" }]
        },
        {
          id: "prior-assistant",
          author: { type: "agent", agentId: "assistant-1" },
          content: [{ type: "text", text: "Earlier answer" }]
        }
      ]
    });
    const channel = web();
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const connection = {
      id: "browser-2",
      tags: connectionTags("browser-2", "conversation-1", "user-2"),
      send
    };
    new ChannelHost({
      channels: { browser: channel },
      resolveMessages,
      onMessage: vi.fn()
    });

    await capability.handlers.onConnect!(connection as never, {} as never);

    expect(protocolFrames(send)).toEqual([
      {
        type: "cf_agent_chat_messages",
        messages: [
          {
            id: "prior-user",
            role: "user",
            parts: [{ type: "text", text: "Earlier question" }]
          },
          {
            id: "prior-assistant",
            role: "assistant",
            parts: [{ type: "text", text: "Earlier answer" }]
          }
        ]
      }
    ]);
  });

  it("serves default useAgentChat initial messages from the Host resolver", async () => {
    const resolveMessages = vi.fn().mockResolvedValue({
      messages: [
        {
          id: "prior-assistant",
          author: { type: "agent" },
          content: [{ type: "text", text: "Earlier answer" }]
        }
      ]
    });
    const resolveIdentity = vi.fn(() => ({
      conversationId: "conversation-1",
      participantId: "user-1"
    }));
    const channel = web({ resolveIdentity });
    const host = new ChannelHost({
      channels: { browser: channel },
      resolveMessages,
      onMessage: vi.fn()
    });

    const response = await host.handleRequest(
      new Request(
        "https://example.com/chat/get-messages?conversationId=conversation-1"
      )
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual([
      {
        id: "prior-assistant",
        role: "assistant",
        parts: [{ type: "text", text: "Earlier answer" }]
      }
    ]);
    expect(resolveIdentity).toHaveBeenCalledOnce();
    expect(resolveMessages).toHaveBeenCalledWith({
      conversationId: "conversation-1"
    });
    await expect(
      host.handleRequest(
        new Request("https://example.com/chat/get-messages", {
          method: "POST"
        })
      )
    ).resolves.toBeUndefined();
    await expect(
      host.handleRequest(new Request("https://example.com/chat/other"))
    ).resolves.toBeUndefined();
  });

  it("ignores request-supplied identities without resolveIdentity", async () => {
    const resolveMessages = vi.fn().mockResolvedValue({
      messages: [
        {
          id: "shared-assistant",
          author: { type: "agent" },
          content: [{ type: "text", text: "Shared answer" }]
        },
        {
          id: "private-assistant",
          author: { type: "agent" },
          content: [
            {
              type: "text",
              text: "Private answer",
              audience: { type: "participant", participantId: "user-1" }
            }
          ]
        }
      ]
    });
    const channel = web();
    const capability = capabilityOf(channel);
    const host = new ChannelHost({
      channels: { browser: channel },
      resolveMessages,
      onMessage: vi.fn()
    });
    const response = await host.handleRequest(
      new Request(
        "https://example.com/chat/get-messages?name=room-1&conversationId=room-1&participantId=user-1"
      )
    );
    const tags = await capability.getConnectionTags!(
      { id: "physical-connection" },
      {
        request: new Request(
          "https://example.com/chat?name=room-1&participantId=user-1"
        )
      }
    );
    const send = vi.fn();
    await capability.handlers.onConnect!(
      { id: "physical-connection", tags, send } as never,
      {} as never
    );

    const expected = [
      {
        id: "shared-assistant",
        role: "assistant",
        parts: [{ type: "text", text: "Shared answer" }]
      }
    ];
    expect(resolveMessages).toHaveBeenCalledWith({
      conversationId: "default-conversation"
    });
    await expect(response?.json()).resolves.toEqual(expected);
    expect(protocolFrames(send)).toEqual([
      { type: "cf_agent_chat_messages", messages: expected }
    ]);
    expect(tags).toEqual([
      "cf-web-conversation:default-conversation",
      "cf-web-participant:default-conversation"
    ]);
  });

  it("does not treat a client transcript projection as canonical ingress", async () => {
    const channel = web();
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const onMessage = vi.fn();
    const onToolResult = vi.fn();
    const onApprovalResponse = vi.fn();
    const onCancel = vi.fn();
    const onConversationReset = vi.fn();
    new ChannelHost({
      channels: { browser: channel },
      onMessage,
      onToolResult,
      onApprovalResponse,
      onCancel,
      onConversationReset
    });

    await capability.handlers.onMessage!(
      {
        id: "browser-1",
        tags: connectionTags("browser-1"),
        send
      } as never,
      JSON.stringify({
        type: "cf_agent_chat_messages",
        messages: [
          {
            id: "browser-copy",
            role: "assistant",
            parts: [{ type: "text", text: "Lossy browser projection" }]
          }
        ]
      }) as never
    );

    for (const callback of [
      onMessage,
      onToolResult,
      onApprovalResponse,
      onCancel,
      onConversationReset
    ]) {
      expect(callback).not.toHaveBeenCalled();
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("shares a conversation across connections while keeping client tools owner-scoped", async () => {
    const channel = web();
    const capability = capabilityOf(channel);
    const ownerSend = vi.fn();
    const memberSend = vi.fn();
    const owner = {
      id: "browser-1",
      tags: connectionTags("browser-1", "conversation-1", "user-1"),
      send: ownerSend
    };
    const member = {
      id: "browser-2",
      tags: connectionTags("browser-2", "conversation-1", "user-2"),
      send: memberSend
    };
    capability.connections.set(owner.id, owner);
    capability.connections.set(member.id, member);
    let observedEvent: unknown;
    let host!: ChannelHost;
    host = new ChannelHost({
      channels: { browser: channel },
      async onMessage(event) {
        observedEvent = event;
        await host.stream(
          event.message.replySurface!,
          streamOf([
            { type: "text", text: "Shared answer" },
            {
              type: "tool-input-available",
              toolCallId: "tool-1",
              toolName: "describeBrowser",
              input: {}
            },
            {
              type: "tool-input-available",
              toolCallId: "server-tool-1",
              toolName: "search",
              input: { query: "Channels" },
              providerExecuted: true
            },
            {
              type: "tool-output-available",
              toolCallId: "server-tool-1",
              output: { matches: 1 },
              providerExecuted: true
            }
          ])
        );
      }
    });

    await capability.handlers.onMessage!(
      owner as never,
      JSON.stringify({
        type: "cf_agent_use_chat_request",
        id: "turn-1",
        init: {
          method: "POST",
          body: JSON.stringify({
            clientTools: [
              {
                name: "describeBrowser",
                parameters: { type: "object" }
              }
            ],
            messages: [
              {
                id: "untrusted-assistant",
                role: "assistant",
                parts: [{ type: "text", text: "Do not broadcast me" }]
              },
              {
                id: "message-1",
                role: "user",
                parts: [{ type: "text", text: "Hi from owner" }]
              }
            ]
          })
        }
      }) as never
    );

    expect(observedEvent).toEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          thread: { id: "conversation-1", isDirectMessage: false },
          actor: { id: "user-1" },
          replySurface: expect.objectContaining({
            address: {
              conversationId: "conversation-1",
              ownerConnectionId: "browser-1",
              requestId: "turn-1",
              participantId: "user-1",
              clientToolNames: ["describeBrowser"]
            }
          })
        })
      })
    );
    expect(protocolFrames(ownerSend)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "cf_agent_chat_messages" })
      ])
    );
    expect(protocolFrames(memberSend)).toEqual(
      expect.arrayContaining([
        {
          type: "cf_agent_chat_messages",
          messages: [
            {
              id: "message-1",
              role: "user",
              parts: [{ type: "text", text: "Hi from owner" }]
            }
          ]
        }
      ])
    );
    expect(responseChunks(ownerSend)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text-delta", delta: "Shared answer" }),
        expect.objectContaining({
          type: "tool-input-available",
          toolCallId: "tool-1",
          toolName: "describeBrowser"
        })
      ])
    );
    expect(responseChunks(memberSend)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text-delta", delta: "Shared answer" }),
        expect.objectContaining({
          type: "tool-input-available",
          toolCallId: "server-tool-1",
          toolName: "search"
        }),
        expect.objectContaining({
          type: "tool-output-available",
          toolCallId: "server-tool-1",
          output: { matches: 1 }
        })
      ])
    );
    expect(responseChunks(memberSend)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool-input-available",
          toolCallId: "tool-1"
        })
      ])
    );
    expect(protocolFrames(memberSend).at(-1)).toEqual({
      body: "",
      done: true,
      id: "turn-1",
      type: "cf_agent_use_chat_response"
    });
  });

  it("dispatches browser turns through ChannelHost and streams the reply", async () => {
    const channel = web();
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const connection = {
      id: "browser-1",
      tags: connectionTags("browser-1"),
      send
    };
    capability.connections.set(connection.id, connection);
    const onMessage = vi.fn();
    let result: DeliveryResult | undefined;
    let host!: ChannelHost;
    host = new ChannelHost({
      channels: { browser: channel },
      async onMessage(event) {
        onMessage(event);
        result = await host.stream(
          event.message.replySurface!,
          streamOf([
            { type: "reasoning", text: "Brief thought" },
            { type: "text", text: "Hello" }
          ])
        );
      }
    });

    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_use_chat_request",
        id: "turn-1",
        init: {
          method: "POST",
          body: JSON.stringify({
            clientTools: [
              {
                name: "describeBrowser",
                description: "Describe this browser",
                parameters: { type: "object" }
              }
            ],
            messages: [
              {
                id: "message-1",
                role: "user",
                parts: [{ type: "text", text: "Hi" }]
              }
            ]
          })
        }
      }) as never
    );

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelKey: "browser",
        route: "browser-1",
        message: expect.objectContaining({
          message: {
            id: "message-1",
            text: "Hi",
            clientTools: [
              {
                name: "describeBrowser",
                description: "Describe this browser",
                inputSchema: { type: "object" }
              }
            ]
          },
          replySurface: surface
        })
      })
    );
    expect(result).toEqual({
      status: "delivered",
      reference: "web:browser-1:request:turn-1"
    });

    const chunks = responseChunks(send) as Array<{
      type: string;
      id?: string;
      delta?: string;
    }>;
    const reasoningId = chunks[0]?.id;
    const textId = chunks[3]?.id;
    expect(reasoningId).toMatch(/^channel-.+-reasoning-1$/);
    expect(textId).toMatch(/^channel-.+-text-1$/);
    expect(chunks).toEqual([
      { type: "reasoning-start", id: reasoningId },
      { type: "reasoning-delta", id: reasoningId, delta: "Brief thought" },
      { type: "reasoning-end", id: reasoningId },
      { type: "text-start", id: textId },
      { type: "text-delta", id: textId, delta: "Hello" },
      { type: "text-end", id: textId }
    ]);
    expect(JSON.parse(send.mock.calls.at(-1)![0])).toEqual({
      body: "",
      done: true,
      id: "turn-1",
      type: "cf_agent_use_chat_response"
    });
  });

  it("reconciles a completed assistant response from canonical history", async () => {
    const resolveMessages = vi.fn().mockResolvedValue({
      messages: [
        {
          id: "message-1",
          author: { type: "participant", participantId: "user-1" },
          content: [{ type: "text", text: "Question" }]
        },
        {
          id: "assistant-1",
          author: { type: "agent" },
          content: [{ type: "text", text: "Canonical answer" }]
        }
      ]
    });
    const channel = web({ resolveMessages });
    const capability = capabilityOf(channel);
    const ownerSend = vi.fn();
    const memberSend = vi.fn();
    capability.connections.set("browser-1", {
      id: "browser-1",
      tags: connectionTags("browser-1", "conversation-1", "user-1"),
      send: ownerSend
    });
    capability.connections.set("browser-2", {
      id: "browser-2",
      tags: connectionTags("browser-2", "conversation-1", "user-2"),
      send: memberSend
    });
    const conversationSurface = {
      ...surface,
      address: {
        conversationId: "conversation-1",
        ownerConnectionId: "browser-1",
        requestId: "turn-1"
      }
    };

    await channel.stream!(
      conversationSurface,
      streamOf([
        { type: "message-start", messageId: "assistant-1" },
        { type: "text", text: "Live answer" },
        { type: "message-finish", finishReason: "stop" }
      ]),
      {}
    );

    expect(resolveMessages).toHaveBeenCalledOnce();
    expect(protocolFrames(memberSend).at(-1)).toEqual({
      type: "cf_agent_chat_messages",
      messages: [
        {
          id: "message-1",
          role: "user",
          parts: [{ type: "text", text: "Question" }]
        },
        {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "Canonical answer" }]
        }
      ]
    });
  });

  it("projects conversation-visible rich chunks into canonical history snapshots", async () => {
    const channel = web({
      resolveMessages: vi.fn().mockResolvedValue({
        messages: [
          {
            id: "assistant-1",
            author: { type: "agent" },
            content: [
              {
                type: "tool-input-available",
                toolCallId: "server-tool-1",
                toolName: "search",
                input: { query: "Channels" },
                providerExecuted: true
              },
              { type: "text", text: "One match" },
              {
                type: "source",
                id: "source-1",
                url: "https://example.com/channels",
                title: "Channels"
              }
            ]
          }
        ]
      })
    });
    const capability = capabilityOf(channel);
    const send = vi.fn();

    await capability.handlers.onConnect!(
      {
        id: "browser-2",
        tags: connectionTags("browser-2", "conversation-1", "user-2"),
        send
      } as never,
      {} as never
    );

    expect(protocolFrames(send)).toEqual([
      {
        type: "cf_agent_chat_messages",
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            parts: [
              {
                type: "tool-search",
                toolCallId: "server-tool-1",
                state: "input-available",
                input: { query: "Channels" },
                providerExecuted: true
              },
              { type: "text", text: "One match" },
              {
                type: "source-url",
                sourceId: "source-1",
                url: "https://example.com/channels",
                title: "Channels"
              }
            ]
          }
        ]
      }
    ]);
  });

  it("projects source documents, files, and persisted data into snapshots", async () => {
    const channel = web({
      resolveMessages: vi.fn().mockResolvedValue({
        messages: [
          {
            id: "assistant-1",
            author: { type: "agent" },
            content: [
              {
                type: "source-document",
                id: "report",
                mediaType: "application/pdf",
                title: "Quarterly report",
                filename: "q3.pdf"
              },
              {
                type: "file",
                url: "https://example.com/chart.png",
                mediaType: "image/png"
              },
              {
                type: "reasoning-file",
                url: "https://example.com/trace.txt",
                mediaType: "text/plain"
              },
              { type: "data", name: "progress", id: "progress-1", data: 100 },
              {
                type: "data",
                name: "typing",
                data: true,
                transient: true
              }
            ]
          }
        ]
      })
    });
    const capability = capabilityOf(channel);
    const send = vi.fn();

    await capability.handlers.onConnect!(
      {
        id: "browser-2",
        tags: connectionTags("browser-2", "conversation-1", "user-2"),
        send
      } as never,
      {} as never
    );

    expect(protocolFrames(send)).toEqual([
      {
        type: "cf_agent_chat_messages",
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            parts: [
              {
                type: "source-document",
                sourceId: "report",
                mediaType: "application/pdf",
                title: "Quarterly report",
                filename: "q3.pdf"
              },
              {
                type: "file",
                url: "https://example.com/chart.png",
                mediaType: "image/png"
              },
              {
                type: "reasoning-file",
                url: "https://example.com/trace.txt",
                mediaType: "text/plain"
              },
              { type: "data-progress", data: 100, id: "progress-1" }
            ]
          }
        ]
      }
    ]);
  });

  it("keeps rich tool state on one canonical part per tool call", async () => {
    const channel = web({
      resolveMessages: vi.fn().mockResolvedValue({
        messages: [
          {
            id: "assistant-1",
            author: { type: "agent" },
            content: [
              {
                type: "tool-input-available",
                toolCallId: "server-tool-1",
                toolName: "search",
                input: { query: "Channels" }
              },
              {
                type: "tool-output-available",
                toolCallId: "server-tool-1",
                output: { matches: 1 }
              },
              {
                type: "tool-input-available",
                toolCallId: "server-tool-2",
                toolName: "deploy",
                input: { environment: "production" }
              },
              {
                type: "tool-output-error",
                toolCallId: "server-tool-2",
                errorText: "deploy failed"
              },
              {
                type: "tool-input-available",
                toolCallId: "server-tool-3",
                toolName: "purge",
                input: {}
              },
              { type: "tool-output-denied", toolCallId: "server-tool-3" }
            ]
          }
        ]
      })
    });
    const capability = capabilityOf(channel);
    const send = vi.fn();

    await capability.handlers.onConnect!(
      {
        id: "browser-2",
        tags: connectionTags("browser-2", "conversation-1", "user-2"),
        send
      } as never,
      {} as never
    );

    expect(protocolFrames(send)).toEqual([
      {
        type: "cf_agent_chat_messages",
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            parts: [
              {
                type: "tool-search",
                toolCallId: "server-tool-1",
                state: "output-available",
                input: { query: "Channels" },
                output: { matches: 1 }
              },
              {
                type: "tool-deploy",
                toolCallId: "server-tool-2",
                state: "output-error",
                input: { environment: "production" },
                errorText: "deploy failed"
              },
              {
                type: "tool-purge",
                toolCallId: "server-tool-3",
                state: "output-denied",
                input: {}
              }
            ]
          }
        ]
      }
    ]);
  });

  it("omits a canonical message that only contains another participant's content", async () => {
    const channel = web({
      resolveMessages: vi.fn().mockResolvedValue({
        messages: [
          {
            id: "assistant-private",
            author: { type: "agent" },
            content: [
              {
                type: "tool-input-available",
                toolCallId: "client-tool-1",
                toolName: "describeBrowser",
                input: {},
                audience: { type: "participant", participantId: "user-1" }
              }
            ]
          }
        ]
      })
    });
    const capability = capabilityOf(channel);
    const send = vi.fn();

    await capability.handlers.onConnect!(
      {
        id: "browser-2",
        tags: connectionTags("browser-2", "conversation-1", "user-2"),
        send
      } as never,
      {} as never
    );

    expect(protocolFrames(send)).toEqual([
      { type: "cf_agent_chat_messages", messages: [] }
    ]);
  });

  it("does not project owner-local client tools into canonical history snapshots", async () => {
    const channel = web({
      resolveMessages: vi.fn().mockResolvedValue({
        messages: [
          {
            id: "assistant-1",
            author: { type: "agent" },
            content: [
              { type: "text", text: "Shared answer" },
              {
                type: "tool-input-available",
                toolCallId: "client-tool-1",
                toolName: "describeBrowser",
                input: {},
                audience: { type: "participant", participantId: "user-1" }
              }
            ]
          }
        ]
      })
    });
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const connection = {
      id: "browser-2",
      tags: connectionTags("browser-2", "conversation-1", "user-2"),
      send
    };

    await capability.handlers.onConnect!(connection as never, {} as never);

    expect(protocolFrames(send)).toEqual([
      {
        type: "cf_agent_chat_messages",
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            parts: [{ type: "text", text: "Shared answer" }]
          }
        ]
      }
    ]);
  });

  it("describes durable Web response correlation at the Host recording seam", async () => {
    const appended: unknown[] = [];
    const open = vi.fn().mockResolvedValue({
      streamId: "response-1",
      cursor: 0,
      append(chunk: unknown) {
        appended.push(chunk);
        return appended.length - 1;
      },
      close: vi.fn(),
      error: vi.fn()
    });
    const streams = {
      open,
      list: vi.fn().mockResolvedValue([]),
      status: vi.fn().mockResolvedValue(null),
      async *read() {}
    };
    const channel = web();
    const host = new ChannelHost({
      channels: { browser: channel },
      streams: streams as never,
      onMessage: vi.fn()
    });

    await host.stream(surface, streamOf([{ type: "text", text: "Hello" }]), {
      response: {
        id: "response-1",
        conversationId: "browser-1",
        messageId: "assistant-1"
      }
    });

    expect(open).toHaveBeenCalledWith("response-1", {
      tag: "browser-1",
      metadata: {
        owner: "channels",
        channelType: "web",
        channelKey: "browser",
        conversationId: "browser-1",
        messageId: "assistant-1",
        webRequestId: "turn-1",
        webOwnerParticipantId: "browser-1",
        webClientToolNames: ["describeBrowser"],
        webContinuation: false
      }
    });
    expect(appended).toEqual([
      { type: "message-start", messageId: "assistant-1" },
      { type: "text-start", id: "assistant-1:part:1" },
      { type: "text", id: "assistant-1:part:1", text: "Hello" },
      { type: "text-end", id: "assistant-1:part:1" }
    ]);
  });

  it("reports a durable-only response as uncertain rather than delivered", async () => {
    const open = vi.fn().mockResolvedValue({
      streamId: "response-1",
      cursor: 0,
      append: vi.fn().mockReturnValue(0),
      close: vi.fn(),
      error: vi.fn()
    });
    const streams = {
      open,
      list: vi.fn().mockResolvedValue([]),
      status: vi.fn().mockResolvedValue(null),
      async *read() {}
    };
    const channel = web();
    const host = new ChannelHost({
      channels: { browser: channel },
      streams: streams as never,
      onMessage: vi.fn()
    });

    await expect(
      host.stream(surface, streamOf([{ type: "text", text: "Hello" }]), {
        response: {
          id: "response-1",
          conversationId: "browser-1",
          messageId: "assistant-1"
        }
      })
    ).resolves.toEqual({
      status: "uncertain",
      reference: "web:browser-1:request:turn-1",
      error: {
        code: "WEB_CHAT_RECORDED_WITHOUT_READER",
        message:
          "The response was recorded for replay without reaching a browser connection"
      }
    });
  });

  it("delivers conversation output after the initiating owner disconnects", async () => {
    const channel = web();
    const capability = capabilityOf(channel);
    const memberSend = vi.fn();
    capability.connections.set("browser-2", {
      id: "browser-2",
      tags: connectionTags("browser-2", "conversation-1", "user-2"),
      send: memberSend
    });
    const host = new ChannelHost({
      channels: { browser: channel },
      onMessage: vi.fn()
    });

    await expect(
      host.stream(
        {
          channelKey: "browser",
          version: 1,
          address: {
            conversationId: "conversation-1",
            ownerConnectionId: "browser-1",
            requestId: "turn-1",
            participantId: "user-1"
          },
          label: "Web chat"
        },
        streamOf([{ type: "text", text: "Shared answer" }])
      )
    ).resolves.toMatchObject({ status: "delivered" });
    expect(responseChunks(memberSend)).toContainEqual(
      expect.objectContaining({ type: "text-delta", delta: "Shared answer" })
    );
  });

  it("pages past newer streams from other Channels to find a Web response", async () => {
    const streamStatus = {
      streamId: "response-1",
      state: "completed" as const,
      cursor: 3,
      tag: "conversation-1",
      metadata: {
        owner: "channels",
        channelType: "web",
        channelKey: "browser",
        conversationId: "conversation-1",
        messageId: "assistant-1",
        webRequestId: "request-1",
        webOwnerParticipantId: "user-1",
        webClientToolNames: []
      },
      createdAt: 1,
      updatedAt: 2,
      closedAt: 2
    };
    const otherChannelStreams = Array.from({ length: 20 }, (_, index) => ({
      streamId: `slack-${index}`,
      state: "completed" as const,
      cursor: 1,
      tag: "conversation-1",
      metadata: {
        owner: "channels",
        channelType: "slack",
        channelKey: "slack",
        conversationId: "conversation-1"
      },
      createdAt: 3,
      updatedAt: 4,
      closedAt: 4
    }));
    const ordered = [...otherChannelStreams, streamStatus].sort(
      (left, right) =>
        right.createdAt - left.createdAt ||
        (left.streamId < right.streamId ? 1 : -1)
    );
    const streams = {
      list: vi.fn(
        async ({
          limit,
          after
        }: {
          limit: number;
          after?: { createdAt: number; streamId: string };
        }) => {
          const start =
            after === undefined
              ? 0
              : ordered.findIndex(
                  (status) => status.streamId === after.streamId
                ) + 1;
          return ordered.slice(start, start + limit);
        }
      ),
      status: vi.fn().mockResolvedValue(streamStatus),
      async *read() {
        yield { seq: 0, chunk: { type: "message-start", messageId: "a-1" } };
      }
    };
    const channel = web();
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const connection = {
      id: "browser-2",
      tags: connectionTags("browser-2", "conversation-1", "user-2"),
      send
    };
    capability.connections.set(connection.id, connection);
    new ChannelHost({
      channels: { browser: channel },
      streams: streams as never,
      resolveMessages: vi.fn().mockResolvedValue({ messages: [] }),
      onMessage: vi.fn()
    });

    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_stream_resume_request",
        probeId: "probe-1"
      }) as never
    );

    expect(streams.list.mock.calls.length).toBeGreaterThan(1);
    expect(protocolFrames(send)).toEqual([
      {
        type: "cf_agent_stream_resuming",
        id: "request-1",
        probeId: "probe-1"
      }
    ]);
  });

  it("discovers and replays a durable response after the resume handshake", async () => {
    const streamStatus = {
      streamId: "response-1",
      state: "completed" as const,
      cursor: 5,
      tag: "conversation-1",
      metadata: {
        owner: "channels",
        channelType: "web",
        channelKey: "browser",
        conversationId: "conversation-1",
        messageId: "assistant-1",
        webRequestId: "request-1",
        webOwnerParticipantId: "user-1",
        webClientToolNames: ["describeBrowser"]
      },
      createdAt: 1,
      updatedAt: 2,
      closedAt: 2
    };
    const durableChunks: ChannelChunk[] = [
      { type: "message-start", messageId: "assistant-1" },
      { type: "text-start", id: "text-1" },
      { type: "text", id: "text-1", text: "Durable answer" },
      { type: "text-end", id: "text-1" },
      { type: "message-finish", finishReason: "stop" }
    ];
    const streams = {
      list: vi.fn().mockResolvedValue([streamStatus]),
      status: vi.fn().mockResolvedValue(streamStatus),
      async *read() {
        for (const [seq, chunk] of durableChunks.entries()) {
          yield { seq, chunk };
        }
      }
    };
    const channel = web();
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const connection = {
      id: "browser-2",
      tags: connectionTags("browser-2", "conversation-1", "user-2"),
      send
    };
    capability.connections.set(connection.id, connection);
    new ChannelHost({
      channels: { browser: channel },
      streams: streams as never,
      resolveMessages: vi.fn().mockResolvedValue({ messages: [] }),
      onMessage: vi.fn()
    });

    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_stream_resume_request",
        probeId: "probe-1"
      }) as never
    );
    expect(protocolFrames(send)).toEqual([
      {
        type: "cf_agent_stream_resuming",
        id: "request-1",
        probeId: "probe-1"
      }
    ]);

    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_stream_resume_ack",
        id: "request-1"
      }) as never
    );

    expect(responseChunks(send)).toEqual([
      { type: "start", messageId: "assistant-1" },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "Durable answer" },
      { type: "text-end", id: "text-1" },
      { type: "finish", finishReason: "stop" }
    ]);
    expect(protocolFrames(send).at(-1)).toMatchObject({
      type: "cf_agent_use_chat_response",
      id: "request-1",
      body: "",
      done: true
    });
  });

  it("can resume before the durable response has produced its first chunk", async () => {
    const streamStatus = {
      streamId: "response-empty-live",
      state: "streaming" as const,
      cursor: 0,
      tag: "conversation-1",
      metadata: {
        owner: "channels",
        channelType: "web",
        channelKey: "browser",
        conversationId: "conversation-1",
        messageId: "assistant-empty-live",
        webRequestId: "request-empty-live",
        webOwnerParticipantId: "user-1",
        webClientToolNames: []
      },
      createdAt: 1,
      updatedAt: 1
    };
    let release!: () => void;
    const produced = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const streams = {
      list: vi.fn().mockResolvedValue([streamStatus]),
      status: vi
        .fn()
        .mockImplementation(async () =>
          settled
            ? { ...streamStatus, state: "completed", cursor: 4, closedAt: 2 }
            : streamStatus
        ),
      async *read() {
        await produced;
        const chunks: ChannelChunk[] = [
          { type: "message-start", messageId: "assistant-empty-live" },
          { type: "text-start", id: "text-1" },
          { type: "text", id: "text-1", text: "Started later" },
          { type: "text-end", id: "text-1" }
        ];
        for (const [seq, chunk] of chunks.entries()) yield { seq, chunk };
      }
    };
    const channel = web();
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const connection = {
      id: "browser-2",
      tags: connectionTags("browser-2", "conversation-1", "user-2"),
      send
    };
    capability.connections.set(connection.id, connection);
    new ChannelHost({
      channels: { browser: channel },
      streams: streams as never,
      resolveMessages: vi.fn().mockResolvedValue({ messages: [] }),
      onMessage: vi.fn()
    });

    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({ type: "cf_agent_stream_resume_request" }) as never
    );
    const replaying = capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_stream_resume_ack",
        id: "request-empty-live"
      }) as never
    );
    await Promise.resolve();
    expect(responseChunks(send)).toEqual([]);

    settled = true;
    release();
    await replaying;
    expect(responseChunks(send)).toEqual([
      { type: "start", messageId: "assistant-empty-live" },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "Started later" },
      { type: "text-end", id: "text-1" }
    ]);
    expect(protocolFrames(send).at(-1)).toMatchObject({
      id: "request-empty-live",
      done: true
    });
  });

  it("replays partial chunks with the durable producer error", async () => {
    const streamStatus = {
      streamId: "response-error",
      state: "errored" as const,
      cursor: 3,
      tag: "conversation-1",
      metadata: {
        owner: "channels",
        channelType: "web",
        channelKey: "browser",
        conversationId: "conversation-1",
        messageId: "assistant-error",
        webRequestId: "request-error",
        webOwnerParticipantId: "user-1",
        webClientToolNames: []
      },
      error: "generation failed",
      createdAt: 1,
      updatedAt: 2,
      closedAt: 2
    };
    const streams = {
      list: vi.fn().mockResolvedValue([streamStatus]),
      status: vi.fn().mockResolvedValue(streamStatus),
      async *read() {
        const chunks: ChannelChunk[] = [
          { type: "message-start", messageId: "assistant-error" },
          { type: "text-start", id: "text-1" },
          { type: "text", id: "text-1", text: "Partial answer" }
        ];
        for (const [seq, chunk] of chunks.entries()) yield { seq, chunk };
      }
    };
    const channel = web();
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const connection = {
      id: "browser-2",
      tags: connectionTags("browser-2", "conversation-1", "user-2"),
      send
    };
    capability.connections.set(connection.id, connection);
    new ChannelHost({
      channels: { browser: channel },
      streams: streams as never,
      resolveMessages: vi.fn().mockResolvedValue({ messages: [] }),
      onMessage: vi.fn()
    });

    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({ type: "cf_agent_stream_resume_request" }) as never
    );
    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_stream_resume_ack",
        id: "request-error"
      }) as never
    );

    expect(responseChunks(send)).toEqual([
      { type: "start", messageId: "assistant-error" },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "Partial answer" }
    ]);
    expect(protocolFrames(send).at(-1)).toEqual({
      type: "cf_agent_use_chat_response",
      id: "request-error",
      body: "generation failed",
      done: true,
      error: true
    });
  });

  it("does not start duplicate replay readers for repeated probes and ACKs", async () => {
    const streamStatus = {
      streamId: "response-duplicate",
      state: "completed" as const,
      cursor: 1,
      tag: "conversation-1",
      metadata: {
        owner: "channels",
        channelType: "web",
        channelKey: "browser",
        conversationId: "conversation-1",
        messageId: "assistant-duplicate",
        webRequestId: "request-duplicate",
        webOwnerParticipantId: "user-1",
        webClientToolNames: []
      },
      createdAt: 1,
      updatedAt: 2,
      closedAt: 2
    };
    let releaseRead!: () => void;
    const holdRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const read = vi.fn(async function* () {
      yield {
        seq: 0,
        chunk: {
          type: "message-start",
          messageId: "assistant-duplicate"
        }
      };
      await holdRead;
    });
    const streams = {
      list: vi.fn().mockResolvedValue([streamStatus]),
      status: vi.fn().mockResolvedValue(streamStatus),
      read
    };
    const channel = web();
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const connection = {
      id: "browser-2",
      tags: connectionTags("browser-2", "conversation-1", "user-2"),
      send
    };
    capability.connections.set(connection.id, connection);
    new ChannelHost({
      channels: { browser: channel },
      streams: streams as never,
      resolveMessages: vi.fn().mockResolvedValue({ messages: [] }),
      onMessage: vi.fn()
    });

    for (const probeId of ["probe-1", "probe-2"]) {
      await capability.handlers.onMessage!(
        connection as never,
        JSON.stringify({
          type: "cf_agent_stream_resume_request",
          probeId
        }) as never
      );
    }
    const replay = capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_stream_resume_ack",
        id: "request-duplicate"
      }) as never
    );
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_stream_resume_request",
        probeId: "probe-during-replay"
      }) as never
    );
    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_stream_resume_ack",
        id: "request-duplicate"
      }) as never
    );
    releaseRead();
    await replay;

    expect(read).toHaveBeenCalledOnce();
    expect(
      protocolFrames(send).filter(
        (frame) =>
          frame.type === "cf_agent_use_chat_response" && frame.done === true
      )
    ).toHaveLength(1);
  });

  it("stops a matching durable replay before dispatching cancellation", async () => {
    const streamStatus = {
      streamId: "response-cancel",
      state: "streaming" as const,
      cursor: 1,
      tag: "conversation-1",
      metadata: {
        owner: "channels",
        channelType: "web",
        channelKey: "browser",
        conversationId: "conversation-1",
        messageId: "assistant-cancel",
        webRequestId: "request-cancel",
        webOwnerParticipantId: "user-1",
        webClientToolNames: []
      },
      createdAt: 1,
      updatedAt: 2
    };
    let replaySignal: AbortSignal | undefined;
    const read = vi.fn(async function* (
      _streamId: string,
      options?: { signal?: AbortSignal }
    ) {
      replaySignal = options?.signal;
      const aborted = new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          reject(options.signal?.reason);
        });
      });
      yield {
        seq: 0,
        chunk: { type: "message-start", messageId: "assistant-cancel" }
      };
      await aborted;
    });
    const channel = web();
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const connection = {
      id: "browser-2",
      tags: connectionTags("browser-2", "conversation-1", "user-2"),
      send
    };
    capability.connections.set(connection.id, connection);
    const onCancel = vi.fn();
    new ChannelHost({
      channels: { browser: channel },
      streams: {
        list: vi.fn().mockResolvedValue([streamStatus]),
        status: vi.fn(),
        read
      } as never,
      resolveMessages: vi.fn().mockResolvedValue({ messages: [] }),
      onCancel
    });

    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_stream_resume_request",
        probeId: "cancel-replay"
      }) as never
    );
    const replay = capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_stream_resume_ack",
        id: "request-cancel"
      }) as never
    );
    await vi.waitFor(() => expect(replaySignal).toBeDefined());
    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_chat_request_cancel",
        id: "request-cancel"
      }) as never
    );
    await replay;

    expect(replaySignal?.aborted).toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(
      protocolFrames(send).filter(
        (frame) =>
          frame.type === "cf_agent_use_chat_response" && frame.done === true
      )
    ).toHaveLength(0);
  });

  it("does not offer a settled response already present in canonical history", async () => {
    const streamStatus = {
      streamId: "response-settled",
      state: "completed" as const,
      cursor: 1,
      tag: "conversation-1",
      metadata: {
        owner: "channels",
        channelType: "web",
        channelKey: "browser",
        conversationId: "conversation-1",
        messageId: "assistant-settled",
        webRequestId: "request-settled",
        webOwnerParticipantId: "user-1",
        webClientToolNames: []
      },
      createdAt: 1,
      updatedAt: 2,
      closedAt: 2
    };
    const streams = {
      list: vi.fn().mockResolvedValue([streamStatus]),
      status: vi.fn(),
      async *read() {}
    };
    const channel = web();
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const connection = {
      id: "browser-2",
      tags: connectionTags("browser-2", "conversation-1", "user-2"),
      send
    };
    capability.connections.set(connection.id, connection);
    new ChannelHost({
      channels: { browser: channel },
      streams: streams as never,
      resolveMessages: vi.fn().mockResolvedValue({
        messages: [
          {
            id: "assistant-settled",
            author: { type: "agent" },
            content: [{ type: "text", text: "Canonical answer" }]
          }
        ]
      }),
      onMessage: vi.fn()
    });

    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_stream_resume_request",
        probeId: "probe-settled"
      }) as never
    );

    expect(protocolFrames(send)).toEqual([
      {
        type: "cf_agent_stream_resume_none",
        reason: "idle",
        probeId: "probe-settled"
      }
    ]);
  });

  it("does not replay participant-local client tools to another participant", async () => {
    const streamStatus = {
      streamId: "response-private",
      state: "completed" as const,
      cursor: 4,
      tag: "conversation-1",
      metadata: {
        owner: "channels",
        channelType: "web",
        channelKey: "browser",
        conversationId: "conversation-1",
        messageId: "assistant-private",
        webRequestId: "request-private",
        webOwnerParticipantId: "user-1",
        webClientToolNames: ["describeBrowser"]
      },
      createdAt: 1,
      updatedAt: 2,
      closedAt: 2
    };
    const streams = {
      list: vi.fn().mockResolvedValue([streamStatus]),
      status: vi.fn().mockResolvedValue(streamStatus),
      async *read() {
        const chunks: ChannelChunk[] = [
          { type: "message-start", messageId: "assistant-private" },
          {
            type: "tool-input-available",
            toolCallId: "tool-1",
            toolName: "describeBrowser",
            input: {}
          },
          { type: "text-start", id: "text-1" },
          { type: "text", id: "text-1", text: "Shared answer" },
          { type: "text-end", id: "text-1" },
          { type: "message-finish", finishReason: "stop" }
        ];
        for (const [seq, chunk] of chunks.entries()) yield { seq, chunk };
      }
    };
    const channel = web();
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const connection = {
      id: "browser-2",
      tags: connectionTags("browser-2", "conversation-1", "user-2"),
      send
    };
    capability.connections.set(connection.id, connection);
    const onToolResult = vi.fn();
    new ChannelHost({
      channels: { browser: channel },
      streams: streams as never,
      resolveMessages: vi.fn().mockResolvedValue({
        messages: [
          {
            id: "assistant-private",
            author: { type: "agent" },
            content: [
              {
                type: "tool-input-available",
                toolCallId: "tool-1",
                toolName: "describeBrowser",
                input: {},
                audience: { type: "participant", participantId: "user-1" }
              },
              { type: "text", text: "Shared answer" }
            ]
          }
        ]
      }),
      onMessage: vi.fn(),
      onToolResult
    });

    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({ type: "cf_agent_stream_resume_request" }) as never
    );
    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_stream_resume_ack",
        id: "request-private"
      }) as never
    );

    expect(responseChunks(send)).toEqual([
      { type: "start", messageId: "assistant-private" },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "Shared answer" },
      { type: "text-end", id: "text-1" },
      { type: "finish", finishReason: "stop" }
    ]);

    const ownerSend = vi.fn();
    const owner = {
      id: "browser-3",
      tags: connectionTags("browser-3", "conversation-1", "user-1"),
      send: ownerSend
    };
    capability.connections.set(owner.id, owner);
    await capability.handlers.onMessage!(
      owner as never,
      JSON.stringify({ type: "cf_agent_stream_resume_request" }) as never
    );
    await capability.handlers.onMessage!(
      owner as never,
      JSON.stringify({
        type: "cf_agent_stream_resume_ack",
        id: "request-private"
      }) as never
    );
    expect(responseChunks(ownerSend)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool-input-available",
          toolCallId: "tool-1",
          toolName: "describeBrowser"
        })
      ])
    );

    await capability.handlers.onMessage!(
      owner as never,
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId: "tool-1",
        toolName: "describeBrowser",
        state: "output-available",
        output: { timezone: "Etc/UTC" },
        autoContinue: false
      }) as never
    );
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          toolCallId: "tool-1",
          toolName: "describeBrowser",
          result: {
            success: true,
            output: { timezone: "Etc/UTC" }
          }
        })
      })
    );
  });

  it("does not apply a stale reconciliation snapshot after streaming", async () => {
    const resolveMessages = vi.fn().mockResolvedValue({
      messages: [
        {
          id: "message-1",
          author: { type: "participant", participantId: "user-1" },
          content: [{ type: "text", text: "Question" }]
        }
      ]
    });
    const channel = web({ resolveMessages });
    const capability = capabilityOf(channel);
    const memberSend = vi.fn();
    capability.connections.set("browser-1", {
      id: "browser-1",
      tags: connectionTags("browser-1", "conversation-1", "user-1"),
      send: vi.fn()
    });
    capability.connections.set("browser-2", {
      id: "browser-2",
      tags: connectionTags("browser-2", "conversation-1", "user-2"),
      send: memberSend
    });

    await channel.stream!(
      {
        ...surface,
        address: {
          conversationId: "conversation-1",
          ownerConnectionId: "browser-1",
          requestId: "turn-1"
        }
      },
      streamOf([
        { type: "message-start", messageId: "assistant-1" },
        { type: "text", text: "Live answer" },
        { type: "message-finish", finishReason: "stop" }
      ]),
      {}
    );

    expect(protocolFrames(memberSend)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "cf_agent_chat_messages" })
      ])
    );
  });

  it("streams rich chunks through the AI SDK converter and preserves explicit ids", async () => {
    const channel = web();
    const capability = capabilityOf(channel);
    const send = vi.fn();
    capability.connections.set("browser-1", {
      id: "browser-1",
      tags: connectionTags("browser-1"),
      send
    });
    const chunks: ChannelChunk[] = [
      {
        type: "message-start",
        messageId: "assistant-1",
        metadata: { model: "test" }
      },
      { type: "step-start" },
      { type: "reasoning-start", id: "reasoning-1" },
      { type: "reasoning", id: "reasoning-1", text: "Think" },
      { type: "reasoning-end", id: "reasoning-1" },
      {
        type: "tool-input-start",
        toolCallId: "tool-1",
        toolName: "search",
        providerExecuted: true
      },
      { type: "tool-input-delta", toolCallId: "tool-1", delta: '{"q":' },
      {
        type: "tool-input-available",
        toolCallId: "tool-1",
        toolName: "search",
        input: { q: "weather" },
        providerExecuted: true
      },
      {
        type: "tool-output-available",
        toolCallId: "tool-1",
        output: { temperature: 20 },
        providerExecuted: true
      },
      { type: "text-start", id: "text-1" },
      { type: "text", id: "text-1", text: "Sunny" },
      { type: "text-end", id: "text-1" },
      {
        type: "source",
        id: "source-1",
        url: "https://example.com/weather",
        title: "Weather"
      },
      { type: "data", name: "weather", id: "data-1", data: { sunny: true } },
      { type: "step-finish" },
      { type: "message-finish", finishReason: "stop", metadata: { tokens: 4 } }
    ];

    await expect(
      channel.stream!(surface, streamOf(chunks), {})
    ).resolves.toEqual({
      status: "delivered",
      reference: "web:browser-1:request:turn-1"
    });

    expect(responseChunks(send)).toEqual([
      {
        type: "start",
        messageId: "assistant-1",
        messageMetadata: { model: "test" }
      },
      { type: "start-step" },
      { type: "reasoning-start", id: "reasoning-1" },
      { type: "reasoning-delta", id: "reasoning-1", delta: "Think" },
      { type: "reasoning-end", id: "reasoning-1" },
      {
        type: "tool-input-start",
        toolCallId: "tool-1",
        toolName: "search",
        providerExecuted: true
      },
      {
        type: "tool-input-delta",
        toolCallId: "tool-1",
        inputTextDelta: '{"q":'
      },
      {
        type: "tool-input-available",
        toolCallId: "tool-1",
        toolName: "search",
        input: { q: "weather" },
        providerExecuted: true
      },
      {
        type: "tool-output-available",
        toolCallId: "tool-1",
        output: { temperature: 20 },
        providerExecuted: true
      },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "Sunny" },
      { type: "text-end", id: "text-1" },
      {
        type: "source-url",
        sourceId: "source-1",
        url: "https://example.com/weather",
        title: "Weather"
      },
      { type: "data-weather", id: "data-1", data: { sunny: true } },
      { type: "finish-step" },
      { type: "finish", finishReason: "stop", messageMetadata: { tokens: 4 } }
    ]);
  });

  it("routes a client-tool result before offering its application continuation", async () => {
    const channel = web();
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const connection = {
      id: "browser-1",
      tags: connectionTags("browser-1"),
      send
    };
    capability.connections.set(connection.id, connection);
    const onToolResult = vi.fn();
    let delivery: DeliveryResult | undefined;
    let host!: ChannelHost;
    host = new ChannelHost({
      channels: { browser: channel },
      async onToolResult(event) {
        onToolResult(event);
        delivery = await host.stream(
          event.result.replySurface!,
          streamOf([{ type: "text", text: "Tool result received" }])
        );
      }
    });
    await channel.stream!(
      surface,
      streamOf([
        {
          type: "tool-input-available",
          toolCallId: "tool-1",
          toolName: "describeBrowser",
          input: { prompt: "describe" }
        }
      ]),
      {}
    );
    send.mockClear();

    const handling = capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId: "tool-1",
        toolName: "describeBrowser",
        output: { timezone: "Europe/London" },
        autoContinue: true,
        clientTools: [
          {
            name: "describeBrowser",
            description: "Describe this browser",
            parameters: { type: "object" }
          }
        ]
      }) as never
    );
    await vi.waitFor(() => expect(onToolResult).toHaveBeenCalledOnce());
    expect(send).not.toHaveBeenCalled();

    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_stream_resume_request",
        probeId: "probe-tool"
      }) as never
    );
    const offer = JSON.parse(send.mock.calls.at(-1)![0]);
    expect(offer).toEqual({
      type: "cf_agent_stream_resuming",
      id: expect.any(String),
      probeId: "probe-tool"
    });

    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_stream_resume_ack",
        id: offer.id
      }) as never
    );
    await handling;

    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        channelKey: "browser",
        route: "browser-1",
        result: expect.objectContaining({
          eventId: "web:browser-1:request:turn-1:tool-result:tool-1",
          toolCallId: "tool-1",
          toolName: "describeBrowser",
          result: {
            success: true,
            output: { timezone: "Europe/London" }
          },
          autoContinue: true,
          clientTools: [
            {
              name: "describeBrowser",
              description: "Describe this browser",
              inputSchema: { type: "object" }
            }
          ],
          replySurface: {
            ...surface,
            label: "Web chat continuation",
            address: {
              conversationId: "browser-1",
              ownerConnectionId: "browser-1",
              requestId: offer.id,
              participantId: "browser-1",
              clientToolNames: ["describeBrowser"],
              continuation: true
            }
          }
        })
      })
    );
    expect(delivery).toEqual({
      status: "delivered",
      reference: `web:browser-1:request:${offer.id}`
    });
    const responseFrames = send.mock.calls
      .map(([frame]) => JSON.parse(frame))
      .filter((frame) => frame.type === "cf_agent_use_chat_response");
    expect(responseFrames).toEqual([
      expect.objectContaining({
        id: offer.id,
        continuation: true,
        done: false
      }),
      expect.objectContaining({
        id: offer.id,
        continuation: true,
        done: false
      }),
      expect.objectContaining({
        id: offer.id,
        continuation: true,
        done: false
      }),
      {
        type: "cf_agent_use_chat_response",
        id: offer.id,
        body: "",
        continuation: true,
        done: true
      }
    ]);
  });

  it("keeps the client pending while the application waits for more tool results", async () => {
    const channel = web();
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const connection = {
      id: "browser-1",
      tags: connectionTags("browser-1"),
      send
    };
    capability.connections.set(connection.id, connection);
    const onToolResult = vi.fn();
    new ChannelHost({ channels: { browser: channel }, onToolResult });
    await channel.stream!(
      surface,
      streamOf([
        {
          type: "tool-input-available",
          toolCallId: "tool-1",
          toolName: "firstTool",
          input: {}
        },
        {
          type: "tool-input-available",
          toolCallId: "tool-2",
          toolName: "secondTool",
          input: {}
        }
      ]),
      {}
    );
    send.mockClear();

    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId: "tool-1",
        toolName: "firstTool",
        output: "first",
        autoContinue: true
      }) as never
    );
    expect(onToolResult).toHaveBeenCalledOnce();

    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_stream_resume_request",
        probeId: "probe-tool"
      }) as never
    );
    expect(JSON.parse(send.mock.calls.at(-1)![0])).toEqual({
      type: "cf_agent_stream_pending",
      id: expect.any(String),
      probeId: "probe-tool"
    });
  });

  it("does not leave a continuation pending for an ignored tool result", async () => {
    const channel = web({ route: () => null });
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const connection = {
      id: "browser-1",
      tags: connectionTags("browser-1"),
      send
    };
    capability.connections.set(connection.id, connection);
    const onToolResult = vi.fn();
    new ChannelHost({ channels: { browser: channel }, onToolResult });
    await channel.stream!(
      surface,
      streamOf([
        {
          type: "tool-input-available",
          toolCallId: "ignored-tool",
          toolName: "ignoredTool",
          input: {}
        }
      ]),
      {}
    );
    send.mockClear();

    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId: "ignored-tool",
        toolName: "ignoredTool",
        output: "ignored",
        autoContinue: true
      }) as never
    );
    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_stream_resume_request",
        probeId: "ignored-tool-probe"
      }) as never
    );

    expect(onToolResult).not.toHaveBeenCalled();
    expect(protocolFrames(send).at(-1)).toEqual({
      type: "cf_agent_stream_resume_none",
      reason: "idle",
      probeId: "ignored-tool-probe"
    });
  });

  it("keeps a concurrently handled continuation when its creator is ignored", async () => {
    let finishIgnoredRoute!: () => void;
    const ignoredRoute = new Promise<void>((resolve) => {
      finishIgnoredRoute = resolve;
    });
    const routeStarted = vi.fn();
    const channel = web({
      route: async (_event, raw) => {
        if (raw.type !== "tool-result" || raw.toolCallId !== "ignored-tool") {
          return "capture";
        }
        routeStarted();
        await ignoredRoute;
        return null;
      }
    });
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const connection = {
      id: "browser-1",
      tags: connectionTags("browser-1"),
      send
    };
    capability.connections.set(connection.id, connection);
    const onToolResult = vi.fn();
    new ChannelHost({ channels: { browser: channel }, onToolResult });
    await channel.stream!(
      surface,
      streamOf([
        {
          type: "tool-input-available",
          toolCallId: "handled-tool",
          toolName: "handledTool",
          input: {}
        },
        {
          type: "tool-input-available",
          toolCallId: "ignored-tool",
          toolName: "ignoredTool",
          input: {}
        }
      ]),
      {}
    );
    send.mockClear();

    const ignored = capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId: "ignored-tool",
        toolName: "ignoredTool",
        output: "ignored-tool",
        autoContinue: true
      }) as never
    );
    await vi.waitFor(() => expect(routeStarted).toHaveBeenCalledOnce());
    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId: "handled-tool",
        toolName: "handledTool",
        output: "handled-tool",
        autoContinue: true
      }) as never
    );
    finishIgnoredRoute();
    await ignored;
    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_stream_resume_request",
        probeId: "existing-tool-probe"
      }) as never
    );

    expect(onToolResult).toHaveBeenCalledOnce();
    expect(protocolFrames(send).at(-1)).toMatchObject({
      type: "cf_agent_stream_pending",
      probeId: "existing-tool-probe"
    });
  });

  it("routes known results from separate requests without conflating continuations", async () => {
    const channel = web();
    const capability = capabilityOf(channel);
    const connection = {
      id: "browser-1",
      tags: connectionTags("browser-1"),
      send: vi.fn()
    };
    capability.connections.set(connection.id, connection);
    const onToolResult = vi.fn();
    new ChannelHost({ channels: { browser: channel }, onToolResult });
    for (const [requestId, toolCallId] of [
      ["turn-1", "tool-1"],
      ["turn-2", "tool-2"]
    ]) {
      await channel.stream!(
        {
          ...surface,
          address: {
            conversationId: "browser-1",
            ownerConnectionId: "browser-1",
            requestId
          }
        },
        streamOf([
          {
            type: "tool-input-available",
            toolCallId,
            toolName: "describeBrowser",
            input: {}
          }
        ]),
        {}
      );
      await capability.handlers.onMessage!(
        connection as never,
        JSON.stringify({
          type: "cf_agent_tool_result",
          toolCallId,
          toolName: "describeBrowser",
          output: requestId,
          autoContinue: true
        }) as never
      );
    }

    expect(onToolResult).toHaveBeenCalledTimes(2);
    expect(
      onToolResult.mock.calls.map(([event]) => event.result.eventId)
    ).toEqual([
      "web:browser-1:request:turn-1:tool-result:tool-1",
      "web:browser-1:request:turn-2:tool-result:tool-2"
    ]);
  });

  it("ignores results for tools this connection was not asked to execute", async () => {
    const channel = web();
    const capability = capabilityOf(channel);
    const onToolResult = vi.fn();
    new ChannelHost({ channels: { browser: channel }, onToolResult });

    await capability.handlers.onMessage!(
      {
        id: "browser-1",
        tags: connectionTags("browser-1"),
        send: vi.fn()
      } as never,
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId: "unknown",
        toolName: "unknownTool",
        output: "not authorized",
        autoContinue: true
      }) as never
    );

    expect(onToolResult).not.toHaveBeenCalled();
  });

  it("rejects a result whose tool name does not match the issued call", async () => {
    const channel = web();
    const capability = capabilityOf(channel);
    const connection = {
      id: "browser-1",
      tags: connectionTags("browser-1"),
      send: vi.fn()
    };
    capability.connections.set(connection.id, connection);
    const onToolResult = vi.fn();
    new ChannelHost({ channels: { browser: channel }, onToolResult });
    await channel.stream!(
      surface,
      streamOf([
        {
          type: "tool-input-available",
          toolCallId: "tool-1",
          toolName: "describeBrowser",
          input: {}
        }
      ]),
      {}
    );

    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId: "tool-1",
        toolName: "differentTool",
        output: "forged",
        autoContinue: true
      }) as never
    );

    expect(onToolResult).not.toHaveBeenCalled();
  });

  it("routes approval requests and responses through the Host approval interface", async () => {
    const channel = web();
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const connection = {
      id: "browser-1",
      tags: connectionTags("browser-1"),
      send
    };
    capability.connections.set(connection.id, connection);
    const onApprovalResponse = vi.fn();
    const host = new ChannelHost({
      channels: { browser: channel },
      onApprovalResponse
    });

    await expect(
      host.requestApproval(surface, {
        interactionId: "deploy-call-1",
        request: {
          title: "Deploy application",
          summary: "Deploy the current revision to production?",
          input: { environment: "production" }
        }
      })
    ).resolves.toMatchObject({ status: "delivered" });
    expect(responseChunks(send)).toEqual([
      { type: "start", messageId: "approval:deploy-call-1" },
      { type: "text-start", id: "approval:deploy-call-1:summary" },
      {
        type: "text-delta",
        id: "approval:deploy-call-1:summary",
        delta: "Deploy the current revision to production?"
      },
      { type: "text-end", id: "approval:deploy-call-1:summary" },
      {
        type: "tool-input-available",
        toolCallId: "deploy-call-1",
        toolName: "approval",
        input: { environment: "production" },
        title: "Deploy application"
      },
      {
        type: "tool-approval-request",
        approvalId: "deploy-call-1",
        toolCallId: "deploy-call-1"
      },
      { type: "finish", finishReason: "tool-calls" }
    ]);
    expect(protocolFrames(send).at(-1)).toMatchObject({
      type: "cf_agent_use_chat_response",
      id: "turn-1",
      done: true
    });

    send.mockClear();
    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_tool_approval",
        toolCallId: "deploy-call-1",
        approved: true,
        autoContinue: false
      }) as never
    );

    expect(onApprovalResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        response: expect.objectContaining({
          type: "approval-response",
          interactionId: "deploy-call-1",
          decision: "approve",
          autoContinue: false,
          reference: "web:browser-1:approval:deploy-call-1"
        })
      })
    );
    expect(onApprovalResponse.mock.calls[0]![0].response).not.toHaveProperty(
      "replySurface"
    );

    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_tool_approval",
        toolCallId: "deploy-call-2",
        approved: false,
        autoContinue: false
      }) as never
    );
    expect(onApprovalResponse).toHaveBeenCalledOnce();
  });

  it("drops approvals that no pending request issued to the participant", async () => {
    const channel = web();
    const capability = capabilityOf(channel);
    const owner = {
      id: "browser-1",
      tags: connectionTags("browser-1"),
      send: vi.fn()
    };
    const bystander = {
      id: "browser-2",
      tags: connectionTags("browser-2", "browser-1", "intruder"),
      send: vi.fn()
    };
    capability.connections.set(owner.id, owner);
    capability.connections.set(bystander.id, bystander);
    const onApprovalResponse = vi.fn();
    const host = new ChannelHost({
      channels: { browser: channel },
      onApprovalResponse
    });

    await capability.handlers.onMessage!(
      owner as never,
      JSON.stringify({
        type: "cf_agent_tool_approval",
        toolCallId: "never-requested",
        approved: true
      }) as never
    );
    expect(onApprovalResponse).not.toHaveBeenCalled();

    await host.requestApproval(surface, {
      interactionId: "deploy-call-1",
      request: { summary: "Approve?", input: {} }
    });
    await capability.handlers.onMessage!(
      bystander as never,
      JSON.stringify({
        type: "cf_agent_tool_approval",
        toolCallId: "deploy-call-1",
        approved: true
      }) as never
    );
    expect(onApprovalResponse).not.toHaveBeenCalled();

    await capability.handlers.onMessage!(
      owner as never,
      JSON.stringify({
        type: "cf_agent_tool_approval",
        toolCallId: "deploy-call-1",
        approved: true
      }) as never
    );
    expect(onApprovalResponse).toHaveBeenCalledOnce();

    await capability.handlers.onMessage!(
      owner as never,
      JSON.stringify({
        type: "cf_agent_tool_approval",
        toolCallId: "deploy-call-1",
        approved: false
      }) as never
    );
    expect(onApprovalResponse).toHaveBeenCalledOnce();
  });

  it("keeps approvals sharing an interaction id per conversation", async () => {
    const channel = web();
    const capability = capabilityOf(channel);
    const first = {
      id: "browser-1",
      tags: connectionTags("browser-1", "conversation-a", "user-1"),
      send: vi.fn()
    };
    const second = {
      id: "browser-2",
      tags: connectionTags("browser-2", "conversation-b", "user-1"),
      send: vi.fn()
    };
    capability.connections.set(first.id, first);
    capability.connections.set(second.id, second);
    const onApprovalResponse = vi.fn();
    const host = new ChannelHost({
      channels: { browser: channel },
      onApprovalResponse
    });
    for (const [conversationId, connectionId] of [
      ["conversation-a", "browser-1"],
      ["conversation-b", "browser-2"]
    ]) {
      await host.requestApproval(
        {
          channelKey: "browser",
          version: 1,
          address: {
            conversationId,
            ownerConnectionId: connectionId,
            requestId: `turn-${conversationId}`,
            participantId: "user-1"
          },
          label: "Web chat"
        },
        {
          interactionId: "deploy-1",
          request: { summary: "Approve?", input: {} }
        }
      );
    }

    await capability.handlers.onMessage!(
      first as never,
      JSON.stringify({
        type: "cf_agent_tool_approval",
        toolCallId: "deploy-1",
        approved: true
      }) as never
    );
    await capability.handlers.onMessage!(
      second as never,
      JSON.stringify({
        type: "cf_agent_tool_approval",
        toolCallId: "deploy-1",
        approved: false
      }) as never
    );

    expect(
      onApprovalResponse.mock.calls.map(([call]) => ({
        conversationId: call.response.thread.id,
        decision: call.response.decision
      }))
    ).toEqual([
      { conversationId: "conversation-a", decision: "approve" },
      { conversationId: "conversation-b", decision: "reject" }
    ]);
  });

  it("keeps an approval continuation pending while the application waits", async () => {
    const channel = web();
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const connection = {
      id: "browser-1",
      tags: connectionTags("browser-1"),
      send
    };
    capability.connections.set(connection.id, connection);
    let finishApplication!: () => void;
    const application = new Promise<void>((resolve) => {
      finishApplication = resolve;
    });
    const onApprovalResponse = vi.fn(() => application);
    const host = new ChannelHost({
      channels: { browser: channel },
      onApprovalResponse
    });
    await host.requestApproval(surface, {
      interactionId: "approval-without-stream",
      request: { summary: "Approve?", input: {} }
    });
    send.mockClear();

    const applyingApproval = capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_tool_approval",
        toolCallId: "approval-without-stream",
        approved: true,
        autoContinue: true
      }) as never
    );
    await vi.waitFor(() => expect(onApprovalResponse).toHaveBeenCalledOnce());
    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_stream_resume_request",
        probeId: "unused-approval-continuation"
      }) as never
    );
    expect(protocolFrames(send).at(-1)).toMatchObject({
      type: "cf_agent_stream_pending",
      probeId: "unused-approval-continuation"
    });
    finishApplication();
    await applyingApproval;

    expect(protocolFrames(send).at(-1)).toMatchObject({
      type: "cf_agent_stream_pending",
      probeId: "unused-approval-continuation"
    });
  });

  it("does not leave a continuation pending for an ignored approval", async () => {
    const channel = web({ route: () => null });
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const connection = {
      id: "browser-1",
      tags: connectionTags("browser-1"),
      send
    };
    capability.connections.set(connection.id, connection);
    const onApprovalResponse = vi.fn();
    const host = new ChannelHost({
      channels: { browser: channel },
      onApprovalResponse
    });
    await host.requestApproval(surface, {
      interactionId: "ignored-approval",
      request: { summary: "Approve?", input: {} }
    });
    send.mockClear();

    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_tool_approval",
        toolCallId: "ignored-approval",
        approved: false,
        autoContinue: true
      }) as never
    );
    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_stream_resume_request",
        probeId: "ignored-approval-probe"
      }) as never
    );

    expect(onApprovalResponse).not.toHaveBeenCalled();
    expect(protocolFrames(send).at(-1)).toEqual({
      type: "cf_agent_stream_resume_none",
      reason: "idle",
      probeId: "ignored-approval-probe"
    });
  });

  it("reports an approval failure before any frame as retryable", async () => {
    const channel = web();
    const capability = capabilityOf(channel);
    capability.connections.set("browser-1", {
      id: "browser-1",
      tags: connectionTags("browser-1"),
      send() {
        throw new Error("socket failed");
      }
    });
    const host = new ChannelHost({ channels: { browser: channel } });

    await expect(
      host.requestApproval(surface, {
        interactionId: "approval-1",
        request: { summary: "Approve?", input: {} }
      })
    ).resolves.toEqual({
      status: "failed",
      retryable: true,
      error: {
        code: "WEB_CHAT_DELIVERY_FAILED",
        message: "socket failed"
      }
    });
  });

  it("lets the application continue an approved interaction through Host.stream", async () => {
    const channel = web();
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const connection = {
      id: "browser-1",
      tags: connectionTags("browser-1"),
      send
    };
    capability.connections.set(connection.id, connection);
    let host!: ChannelHost;
    const onApprovalResponse = vi.fn(async ({ response }) => {
      if (!response.replySurface) throw new Error("Missing approval surface");
      await host.stream(
        response.replySurface,
        streamOf([{ type: "text", text: "Approved by application" }])
      );
    });
    host = new ChannelHost({
      channels: { browser: channel },
      onApprovalResponse
    });
    await host.requestApproval(surface, {
      interactionId: "deploy-call-1",
      request: { summary: "Approve?", input: {} }
    });
    send.mockClear();

    const applyingApproval = capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_tool_approval",
        toolCallId: "deploy-call-1",
        approved: true,
        autoContinue: true
      }) as never
    );
    await vi.waitFor(() => expect(onApprovalResponse).toHaveBeenCalledOnce());
    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_stream_resume_request",
        probeId: "approval-continuation"
      }) as never
    );
    const offer = protocolFrames(send).find(
      (frame) => frame.type === "cf_agent_stream_resuming"
    );
    expect(offer).toMatchObject({ probeId: "approval-continuation" });
    expect(onApprovalResponse.mock.calls[0]![0].response.operationId).toBe(
      offer?.id
    );
    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_stream_resume_ack",
        id: offer?.id
      }) as never
    );
    await applyingApproval;

    expect(responseChunks(send)).toContainEqual({
      type: "text-delta",
      id: expect.any(String),
      delta: "Approved by application"
    });
  });

  it("routes a known client-tool error without starting a continuation", async () => {
    const channel = web();
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const connection = {
      id: "browser-1",
      tags: connectionTags("browser-1"),
      send
    };
    capability.connections.set(connection.id, connection);
    const onToolResult = vi.fn();
    new ChannelHost({ channels: { browser: channel }, onToolResult });
    await channel.stream!(
      surface,
      streamOf([
        {
          type: "tool-input-available",
          toolCallId: "tool-1",
          toolName: "describeBrowser",
          input: {}
        }
      ]),
      {}
    );
    send.mockClear();

    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId: "tool-1",
        toolName: "describeBrowser",
        output: null,
        state: "output-error",
        errorText: "Permission denied",
        autoContinue: false
      }) as never
    );

    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          result: { success: false, error: "Permission denied" }
        })
      })
    );
    expect(onToolResult.mock.calls[0]![0].result).not.toHaveProperty(
      "replySurface"
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("dispatches a conversation reset before acknowledging every member", async () => {
    const channel = web();
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const memberSend = vi.fn();
    const connection = {
      id: "browser-1",
      tags: connectionTags("browser-1"),
      send
    };
    capability.connections.set(connection.id, connection);
    capability.connections.set("browser-2", {
      id: "browser-2",
      tags: connectionTags("browser-2", "browser-1"),
      send: memberSend
    });
    let finishReset!: () => void;
    const resetting = new Promise<void>((resolve) => {
      finishReset = resolve;
    });
    const onConversationReset = vi.fn(() => resetting);
    new ChannelHost({
      channels: { browser: channel },
      onConversationReset
    });

    const clearing = capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({ type: "cf_agent_chat_clear" }) as never
    );
    await vi.waitFor(() => expect(onConversationReset).toHaveBeenCalledOnce());
    expect(send).not.toHaveBeenCalled();
    expect(memberSend).not.toHaveBeenCalled();
    finishReset();
    await clearing;

    expect(onConversationReset).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          type: "conversation-reset-request",
          thread: { id: "browser-1", isDirectMessage: false },
          actor: expect.objectContaining({ id: "browser-1" })
        })
      })
    );
    for (const member of [send, memberSend]) {
      expect(JSON.parse(member.mock.calls[0]![0])).toEqual({
        type: "cf_agent_chat_clear"
      });
    }
  });

  it("does not emit an old response after reset acknowledgement", async () => {
    const channel = web();
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const connection = {
      id: "browser-1",
      tags: connectionTags("browser-1"),
      send
    };
    capability.connections.set(connection.id, connection);
    new ChannelHost({
      channels: { browser: channel },
      onConversationReset: vi.fn()
    });
    const delivery = channel.stream!(
      surface,
      new ReadableStream<ChannelChunk>({
        start(controller) {
          controller.enqueue({ type: "text", text: "Partial" });
        }
      }),
      {}
    );
    await vi.waitFor(() => expect(responseChunks(send)).toHaveLength(2));

    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({ type: "cf_agent_chat_clear" }) as never
    );
    await delivery;

    expect(protocolFrames(send).at(-1)).toEqual({
      type: "cf_agent_chat_clear"
    });
  });

  it("does not rehydrate admitted messages after a conversation reset", async () => {
    const resolveMessages = vi.fn().mockResolvedValue({ messages: [] });
    const channel = web();
    const capability = capabilityOf(channel);
    const owner = {
      id: "browser-1",
      tags: connectionTags("browser-1", "conversation-1", "user-1"),
      send: vi.fn()
    };
    capability.connections.set(owner.id, owner);
    new ChannelHost({
      channels: { browser: channel },
      resolveMessages,
      onMessage: vi.fn(),
      onConversationReset: vi.fn()
    });
    await capability.handlers.onMessage!(
      owner as never,
      JSON.stringify({
        type: "cf_agent_use_chat_request",
        id: "turn-1",
        init: {
          body: JSON.stringify({
            messages: [
              {
                id: "message-1",
                role: "user",
                parts: [{ type: "text", text: "Transient question" }]
              }
            ]
          })
        }
      }) as never
    );
    await capability.handlers.onMessage!(
      owner as never,
      JSON.stringify({ type: "cf_agent_chat_clear" }) as never
    );

    const replacementSend = vi.fn();
    await capability.handlers.onConnect!(
      {
        id: "browser-2",
        tags: connectionTags("browser-2", "conversation-1", "user-1"),
        send: replacementSend
      } as never,
      {} as never
    );

    expect(protocolFrames(replacementSend)).toEqual([
      { type: "cf_agent_chat_messages", messages: [] }
    ]);
  });

  it("does not acknowledge a conversation reset ignored by application routing", async () => {
    const channel = web({ route: () => null });
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const connection = {
      id: "browser-1",
      tags: connectionTags("browser-1"),
      send
    };
    capability.connections.set(connection.id, connection);
    const onConversationReset = vi.fn();
    new ChannelHost({
      channels: { browser: channel },
      onConversationReset
    });

    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({ type: "cf_agent_chat_clear" }) as never
    );

    expect(onConversationReset).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not acknowledge a rejected conversation reset", async () => {
    const channel = web();
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const connection = {
      id: "browser-1",
      tags: connectionTags("browser-1"),
      send
    };
    capability.connections.set(connection.id, connection);
    new ChannelHost({
      channels: { browser: channel },
      onConversationReset: () => {
        throw new Error("Reset denied");
      }
    });

    await expect(
      capability.handlers.onMessage!(
        connection as never,
        JSON.stringify({ type: "cf_agent_chat_clear" }) as never
      )
    ).rejects.toThrow("Reset denied");
    expect(send).not.toHaveBeenCalled();
  });

  it("answers resume probes without inventing durable replay", async () => {
    const channel = web();
    const capability = capabilityOf(channel);
    const send = vi.fn();

    await capability.handlers.onMessage!(
      { id: "browser-1", tags: connectionTags("browser-1"), send } as never,
      JSON.stringify({
        type: "cf_agent_stream_resume_request",
        probeId: "probe-1"
      }) as never
    );

    expect(JSON.parse(send.mock.calls[0]![0])).toEqual({
      type: "cf_agent_stream_resume_none",
      reason: "idle",
      probeId: "probe-1"
    });
  });

  it("blocks cancellation received while canonical history resolves", async () => {
    let finishHistory!: () => void;
    const history = new Promise<void>((resolve) => {
      finishHistory = resolve;
    });
    const resolveMessages = vi.fn(async () => {
      await history;
      return { messages: [] };
    });
    const channel = web();
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const connection = {
      id: "browser-1",
      tags: connectionTags("browser-1"),
      send
    };
    capability.connections.set(connection.id, connection);
    capability.connections.set("browser-2", {
      id: "browser-2",
      tags: connectionTags("browser-2", "browser-1", "user-2"),
      send: vi.fn()
    });
    let streamResult: DeliveryResult | undefined;
    let host!: ChannelHost;
    const onMessage = vi.fn(async ({ message }) => {
      streamResult = await host.stream(
        message.replySurface,
        streamOf([{ type: "text", text: "too late" }])
      );
    });
    host = new ChannelHost({
      channels: { browser: channel },
      resolveMessages,
      onMessage,
      onCancel: vi.fn()
    });

    const handling = capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_use_chat_request",
        id: "turn-during-history",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: "user-during-history",
                role: "user",
                parts: [{ type: "text", text: "Wait" }]
              }
            ]
          })
        }
      }) as never
    );
    await vi.waitFor(() => expect(resolveMessages).toHaveBeenCalledOnce());
    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_chat_request_cancel",
        id: "turn-during-history"
      }) as never
    );
    finishHistory();
    await handling;

    expect(onMessage).toHaveBeenCalledOnce();
    expect(streamResult).toMatchObject({
      status: "failed",
      retryable: false,
      error: { code: "WEB_CHAT_REQUEST_CANCELLED" }
    });
  });

  it("blocks a cancelled response that starts after application work", async () => {
    const channel = web();
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const connection = {
      id: "browser-1",
      tags: connectionTags("browser-1"),
      send
    };
    capability.connections.set(connection.id, connection);
    let continueApplication!: () => void;
    const application = new Promise<void>((resolve) => {
      continueApplication = resolve;
    });
    let streamResult: DeliveryResult | undefined;
    let host!: ChannelHost;
    const onMessage = vi.fn(async ({ message }) => {
      await application;
      streamResult = await host.stream(
        message.replySurface,
        streamOf([{ type: "text", text: "too late" }])
      );
    });
    const onCancel = vi.fn();
    host = new ChannelHost({
      channels: { browser: channel },
      onMessage,
      onCancel
    });

    const handling = capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_use_chat_request",
        id: "turn-before-cancel",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: "user-before-cancel",
                role: "user",
                parts: [{ type: "text", text: "Wait" }]
              }
            ]
          })
        }
      }) as never
    );
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
    await capability.handlers.onMessage!(
      connection as never,
      JSON.stringify({
        type: "cf_agent_chat_request_cancel",
        id: "turn-before-cancel"
      }) as never
    );
    continueApplication();
    await handling;

    expect(streamResult).toMatchObject({
      status: "failed",
      retryable: false,
      error: { code: "WEB_CHAT_REQUEST_CANCELLED" }
    });
    expect(
      protocolFrames(send).filter(
        (frame) => frame.type === "cf_agent_use_chat_response"
      )
    ).toEqual([]);
  });

  it("cancels the matching active stream and dispatches the request", async () => {
    const channel = web();
    const capability = capabilityOf(channel);
    const send = vi.fn();
    const onCancel = vi.fn();
    new ChannelHost({ channels: { browser: channel }, onCancel });
    capability.connections.set("browser-1", {
      id: "browser-1",
      tags: connectionTags("browser-1"),
      send
    });
    const chunks = new ReadableStream<ChannelChunk>({
      start(controller) {
        controller.enqueue({ type: "text", text: "Partial" });
      }
    });
    const delivery = channel.stream!(surface, chunks, {});

    await vi.waitFor(() =>
      expect(responseChunks(send)).toEqual([
        { type: "text-start", id: expect.any(String) },
        { type: "text-delta", id: expect.any(String), delta: "Partial" }
      ])
    );
    await capability.handlers.onMessage!(
      { id: "browser-1", tags: connectionTags("browser-1"), send } as never,
      JSON.stringify({
        type: "cf_agent_chat_request_cancel",
        id: "turn-1"
      }) as never
    );

    expect(onCancel).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          type: "cancel-request",
          operationId: "turn-1",
          thread: { id: "browser-1", isDirectMessage: false },
          actor: expect.objectContaining({ id: "browser-1" })
        })
      })
    );
    await expect(delivery).resolves.toMatchObject({
      status: "uncertain",
      reference: "web:browser-1:request:turn-1",
      error: { code: "WEB_CHAT_REQUEST_CANCELLED" }
    });
    expect(responseChunks(send)).toEqual([
      { type: "text-start", id: expect.any(String) },
      { type: "text-delta", id: expect.any(String), delta: "Partial" }
    ]);
  });

  it("fails when the connection is unavailable", async () => {
    const channel = web();
    const chunks = streamOf([{ type: "text", text: "Hello" }]);

    await expect(channel.stream!(surface, chunks, {})).resolves.toEqual({
      status: "failed",
      retryable: true,
      error: {
        code: "WEB_CHAT_CONNECTION_UNAVAILABLE",
        message: "The browser connection is no longer available"
      }
    });
  });

  it("reports an interrupted stream as uncertain after sending a partial reply", async () => {
    const channel = web();
    const capability = capabilityOf(channel);
    const send = vi.fn();
    capability.connections.set("browser-1", {
      id: "browser-1",
      tags: connectionTags("browser-1"),
      send
    });

    await expect(
      channel.stream!(
        surface,
        streamOf(
          [{ type: "text", text: "Partial" }],
          new Error("model failed")
        ),
        {}
      )
    ).resolves.toEqual({
      status: "uncertain",
      reference: "web:browser-1:request:turn-1",
      error: { code: "WEB_CHAT_STREAM_INTERRUPTED", message: "model failed" }
    });
    expect(responseChunks(send)).toHaveLength(3);
    expect(JSON.parse(send.mock.calls.at(-1)![0])).toEqual({
      body: "model failed",
      done: true,
      error: true,
      id: "turn-1",
      type: "cf_agent_use_chat_response"
    });
  });

  it("reports a send failure before the first frame as retryable", async () => {
    const channel = web();
    const capability = capabilityOf(channel);
    const send = vi.fn(() => {
      throw new Error("socket closed");
    });
    capability.connections.set("browser-1", {
      id: "browser-1",
      tags: connectionTags("browser-1"),
      send
    });

    await expect(
      channel.stream!(surface, streamOf([{ type: "text", text: "Hello" }]), {})
    ).resolves.toEqual({
      status: "failed",
      retryable: true,
      error: { code: "WEB_CHAT_DELIVERY_FAILED", message: "socket closed" }
    });
  });
});
