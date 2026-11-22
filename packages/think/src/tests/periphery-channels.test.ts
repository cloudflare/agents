import type { UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { defaultAttachmentText, deliverReplyAttachments } from "../attachments";
import type { NormalizedChannelDefinition } from "../channels";
import {
  deliverChannelNotice,
  resolveChannelContext,
  type ChannelEvent
} from "../channels/runtime";
import { MediaEvictionPasses } from "../media-eviction";
import { declaredOverrides } from "../overrides";
import type { ReplyAttachment } from "../think";
import {
  channelFromMessages,
  reservedMetadataOf,
  stampTurnContext,
  stripReservedMetadata,
  turnMetadataFromMessages
} from "../turn-metadata";

const user = (id: string, metadata?: Record<string, unknown>) =>
  ({ id, role: "user", parts: [], metadata }) as UIMessage;

describe("turn metadata", () => {
  it("stamps user messages only", () => {
    const assistant = { id: "a", role: "assistant", parts: [] } as UIMessage;
    const stamped = stampTurnContext([user("u"), assistant], "web", {
      who: "me"
    });
    expect(stamped[0].metadata).toEqual({
      channel: "web",
      turnMetadata: { who: "me" }
    });
    expect(stamped[1]).toBe(assistant);
    const unchanged = [user("u")];
    expect(stampTurnContext(unchanged, undefined)).toBe(unchanged);
  });

  it("reads the latest user message's stamp", () => {
    const messages = [
      user("1", { channel: "old" }),
      user("2", { channel: "new", turnMetadata: { a: 1 } })
    ];
    expect(channelFromMessages(messages)).toBe("new");
    expect(turnMetadataFromMessages(messages)).toEqual({ a: 1 });
    expect(channelFromMessages([user("1", { channel: 3 })])).toBeUndefined();
    expect(
      turnMetadataFromMessages([user("1", { turnMetadata: [1] })])
    ).toBeUndefined();
  });

  it("strips and reads the reserved keys", () => {
    const message = user("1", { channel: "web", other: true });
    expect(reservedMetadataOf(message)).toEqual({ channel: "web" });
    expect(stripReservedMetadata(message).metadata).toEqual({ other: true });
    expect(
      "metadata" in stripReservedMetadata(user("2", { channel: "x" }))
    ).toBe(false);
    const plain = user("3", { other: 1 });
    expect(stripReservedMetadata(plain)).toBe(plain);
    expect(reservedMetadataOf(plain)).toBeUndefined();
  });
});

describe("channel runtime", () => {
  const registry = new Map<string, NormalizedChannelDefinition>([
    ["web", { id: "web", kind: "web" } as NormalizedChannelDefinition],
    ["tg", { id: "tg", kind: "messenger" } as NormalizedChannelDefinition]
  ]);

  it("resolves a registered channel and reports it", () => {
    const events: ChannelEvent[] = [];
    const ctx = resolveChannelContext("tg", {
      registry,
      requestId: "r",
      messengerContext: () => ({ messengerId: "tg" }) as never,
      emit: (event) => events.push(event)
    });
    expect(ctx?.channelId).toBe("tg");
    expect(ctx?.messenger).toEqual({ messengerId: "tg" });
    expect(events[0]).toEqual({
      type: "channel:resolved",
      payload: { channel: "tg", kind: "messenger", requestId: "r" }
    });
  });

  it("warns about an unknown channel only when a registry exists", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const options = {
      requestId: undefined,
      messengerContext: () => undefined,
      emit: () => {}
    };
    expect(
      resolveChannelContext("nope", { ...options, registry })
    ).toBeUndefined();
    expect(
      resolveChannelContext("nope", { ...options, registry: undefined })
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("appends a web notice to the transcript", async () => {
    const added: UIMessage[] = [];
    const events: ChannelEvent[] = [];
    await deliverChannelNotice(
      "hello",
      { informModel: true },
      {
        channelId: "web",
        registry,
        surface: async () => undefined,
        addMessages: async (messages) => {
          added.push(...messages);
        },
        emit: (event) => events.push(event)
      }
    );
    expect(added[0].parts).toEqual([
      { type: "text", text: "[Delivered to the user out of band] hello" }
    ]);
    expect(events[0].type).toBe("notice:delivered");
  });

  it("posts to a messenger surface and fails without one", async () => {
    const post = vi.fn(async () => {});
    const events: ChannelEvent[] = [];
    const target = {
      channelId: "tg",
      registry,
      addMessages: async () => {},
      emit: (event: ChannelEvent) => events.push(event)
    };
    await deliverChannelNotice({ markdown: "**hi**" }, undefined, {
      ...target,
      surface: async () => ({ post }) as never
    });
    expect(post).toHaveBeenCalledWith({ markdown: "**hi**" });
    await expect(
      deliverChannelNotice("hi", undefined, {
        ...target,
        surface: async () => undefined
      })
    ).rejects.toThrow(/pass \{ thread \}/);
    expect(events.map((e) => e.type)).toEqual([
      "notice:delivered",
      "notice:failed"
    ]);
  });
});

describe("reply attachments", () => {
  it("renders cards and email drafts, skips the rest", () => {
    expect(
      defaultAttachmentText({ type: "card", payload: { a: 1 } } as never)
    ).toEqual({ markdown: '```json\n{\n  "a": 1\n}\n```' });
    expect(
      defaultAttachmentText({
        type: "email_draft",
        to: ["a@b.c"],
        subject: "Hi"
      } as never)
    ).toEqual({ markdown: "**Email draft**\nTo: a@b.c\nSubject: Hi" });
    expect(
      defaultAttachmentText({ type: "voice_note" } as never)
    ).toBeUndefined();
  });

  it("posts what renders and survives failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const posted: unknown[] = [];
    const attachments = [
      { type: "a" },
      { type: "b" },
      { type: "c" },
      { type: "d" }
    ] as unknown as ReplyAttachment[];
    await deliverReplyAttachments(
      attachments,
      (attachment) => {
        if (attachment.type === "b") throw new Error("render");
        if (attachment.type === "c") return undefined;
        return attachment.type;
      },
      async (rendered) => {
        if (rendered === "d") throw new Error("post");
        posted.push(rendered);
      }
    );
    expect(posted).toEqual(["a"]);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe("declaredOverrides", () => {
  class Base {
    hook() {
      return "base";
    }
  }
  const overrides = declaredOverrides(() => Base.prototype);
  class Plain extends Base {}
  class Custom extends Base {
    override hook() {
      return "custom";
    }
  }

  it("tells a subclass declaration from an inherited method", () => {
    overrides.snapshot(Plain.prototype);
    overrides.snapshot(Custom.prototype);
    // Copying the method onto the concrete prototype after the snapshot (what
    // Agent's wrapper does) does not count as an override.
    Object.defineProperty(Plain.prototype, "hook", {
      value: Base.prototype.hook,
      configurable: true
    });
    expect(overrides.isOverridden(new Plain(), "hook")).toBe(false);
    expect(overrides.isOverridden(new Custom(), "hook")).toBe(true);
    const field = new Plain();
    Object.defineProperty(field, "hook", { value: () => "field" });
    expect(overrides.isOverridden(field, "hook")).toBe(true);
  });
});

describe("MediaEvictionPasses", () => {
  const media = (id: string) =>
    ({
      id,
      role: "user",
      parts: [
        {
          type: "file",
          mediaType: "image/png",
          url: `data:image/png;base64,${"A".repeat(4000)}`
        }
      ]
    }) as UIMessage;

  it("does nothing when eviction is off", async () => {
    const passes = new MediaEvictionPasses({
      config: () => null,
      truncationStep: () => 1,
      cachedMessages: () => [],
      agedRowsHiddenFromCache: () => false,
      storedBytes: () => null,
      rowStats: async () => [],
      readMessage: async () => null,
      openFiles: () => ({ write: async () => {} }),
      updateMessage: async () => {},
      emitEvicted: () => {},
      queueRouted: async () => {}
    });
    passes.request();
    expect(await passes.run()).toBeNull();
  });

  it("writes every payload of a pass to the workspace it opened with", async () => {
    const written: string[] = [];
    let workspace = "first";
    const rows = Array.from({ length: 8 }, (_, i) => ({
      id: `m${i}`,
      bytes: i < 2 ? 10_000 : 10
    }));
    const passes = new MediaEvictionPasses({
      config: () => ({
        keepRecentMessages: 2,
        minPartBytes: 100,
        maxRowsPerPass: 10
      }),
      truncationStep: () => 1,
      cachedMessages: () => [],
      agedRowsHiddenFromCache: () => false,
      storedBytes: () => null,
      rowStats: async () => rows,
      readMessage: async (id) => media(id),
      openFiles: () => {
        const opened = workspace;
        return {
          write: async (path) => void written.push(`${opened}:${path}`)
        };
      },
      updateMessage: async () => {
        // An agent may swap its workspace reference mid-pass.
        workspace = "second";
      },
      emitEvicted: () => {},
      queueRouted: async () => {}
    });
    const result = await passes.run();
    expect(result?.messages).toBe(2);
    expect(written).toHaveLength(2);
    expect(written.every((entry) => entry.startsWith("first:"))).toBe(true);
  });
});
