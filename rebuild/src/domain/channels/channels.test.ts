import { describe, expect, it, vi } from "vitest";
import { createEventBus, type ObservabilityEvent } from "../../kernel/events.js";
import type { ToolSet } from "../tools/types.js";
import { createChannelService, type ChannelContext, type ChannelDefinition } from "./channels.js";

function bus() {
  return createEventBus({ agent: "test", name: "agent-1" }, () => 0);
}

function makeService(deps: { transcriptNotice?: (text: string, informModel: boolean) => Promise<void> } = {}) {
  const events: ObservabilityEvent[] = [];
  const b = bus();
  b.subscribe("*", (e) => events.push(e));
  const transcriptNotice = deps.transcriptNotice ?? vi.fn(async () => {});
  const service = createChannelService({ bus: b, transcriptNotice });
  return { service, events, transcriptNotice: transcriptNotice as ReturnType<typeof vi.fn> };
}

describe("createChannelService", () => {
  describe("implicit web channel", () => {
    it("always resolves 'web' even with no registration", () => {
      const { service } = makeService();
      expect(service.resolve("web")).toEqual({ channelId: "web", kind: "web" });
    });

    it("resolve(undefined) yields undefined (a turn with no channel applies no policy)", () => {
      const { service } = makeService();
      expect(service.resolve(undefined)).toBeUndefined();
    });

    it("resolve() of an unregistered id yields undefined", () => {
      const { service } = makeService();
      expect(service.resolve("nope")).toBeUndefined();
    });

    it("register() may override the web channel's policy without removing it", () => {
      const { service } = makeService();
      service.register({ web: { kind: "web", instructions: "custom web instructions" } });
      expect(service.resolve("web")).toEqual({ channelId: "web", kind: "web" });
    });
  });

  describe("register", () => {
    it("registers a new channel id and it becomes resolvable", () => {
      const { service } = makeService();
      service.register({ tg: { kind: "messenger" } });
      expect(service.resolve("tg")).toEqual({ channelId: "tg", kind: "messenger" });
    });

    it("throws ValidationError on a channel-id collision with an already-declared channel", () => {
      const { service } = makeService();
      service.register({ tg: { kind: "messenger" } });
      expect(() => service.register({ tg: { kind: "messenger" } })).toThrow();
    });

    it("re-registering 'web' never collides", () => {
      const { service } = makeService();
      service.register({ web: { kind: "web" } });
      expect(() => service.register({ web: { kind: "web" } })).not.toThrow();
    });
  });

  describe("policyFor", () => {
    it("returns {} for an unresolved channel", async () => {
      const { service } = makeService();
      expect(await service.policyFor("nope")).toEqual({});
      expect(await service.policyFor(undefined)).toEqual({});
    });

    it("resolves a static string instructions field", async () => {
      const { service } = makeService();
      service.register({ tg: { kind: "messenger", instructions: "be terse" } });
      const policy = await service.policyFor("tg");
      expect(policy.instructions).toBe("be terse");
    });

    it("resolves an async function instructions field with the channel context", async () => {
      const { service } = makeService();
      service.register({
        tg: {
          kind: "messenger",
          instructions: async (ctx: ChannelContext) => `hello ${ctx.channelId}/${ctx.kind}`,
        },
      });
      const policy = await service.policyFor("tg");
      expect(policy.instructions).toBe("hello tg/messenger");
    });

    it("carries maxTurns through", async () => {
      const { service } = makeService();
      service.register({ tg: { kind: "messenger", maxTurns: 3 } });
      const policy = await service.policyFor("tg");
      expect(policy.maxTurns).toBe(3);
    });

    it("wraps the tools filter so it can remove but not add tool names", async () => {
      const { service } = makeService();
      service.register({
        tg: {
          kind: "messenger",
          tools: (all: ToolSet) => {
            const result: ToolSet = {};
            if (all.keep) result.keep = all.keep;
            return result;
          },
        },
      });
      const policy = await service.policyFor("tg");
      const all: ToolSet = { keep: {} as ToolSet[string], drop: {} as ToolSet[string] };
      expect(Object.keys(policy.toolFilter!(all))).toEqual(["keep"]);
    });

    it("throws if the tools filter introduces a tool name not present in the input", async () => {
      const { service } = makeService();
      service.register({
        tg: {
          kind: "messenger",
          tools: (all: ToolSet) => ({ ...all, invented: {} as ToolSet[string] }),
        },
      });
      const policy = await service.policyFor("tg");
      expect(() => policy.toolFilter!({})).toThrow();
    });
  });

  describe("active / runWithActive", () => {
    it("active() is undefined outside any runWithActive scope", () => {
      const { service } = makeService();
      expect(service.active()).toBeUndefined();
    });

    it("active() reflects the context for the duration of runWithActive", async () => {
      const { service } = makeService();
      const ctx: ChannelContext = { channelId: "web", kind: "web" };
      let observed: ChannelContext | undefined;
      await service.runWithActive(ctx, async () => {
        observed = service.active();
      });
      expect(observed).toEqual(ctx);
      expect(service.active()).toBeUndefined();
    });

    it("restores the previous active context after a nested scope, even on throw", async () => {
      const { service } = makeService();
      const outer: ChannelContext = { channelId: "web", kind: "web" };
      const inner: ChannelContext = { channelId: "tg", kind: "messenger" };
      await service.runWithActive(outer, async () => {
        await expect(
          service.runWithActive(inner, async () => {
            expect(service.active()).toEqual(inner);
            throw new Error("boom");
          })
        ).rejects.toThrow("boom");
        expect(service.active()).toEqual(outer);
      });
      expect(service.active()).toBeUndefined();
    });

    it("undefined context leaves the active scope unchanged", async () => {
      const { service } = makeService();
      const outer: ChannelContext = { channelId: "web", kind: "web" };
      await service.runWithActive(outer, async () => {
        await service.runWithActive(undefined, async () => {
          expect(service.active()).toEqual(outer);
        });
      });
    });
  });

  describe("deliverNotice", () => {
    it("defaults to the web channel: writes to the transcript", async () => {
      const { service, transcriptNotice, events } = makeService();
      await service.deliverNotice("hello");
      expect(transcriptNotice).toHaveBeenCalledWith("hello", expect.any(Boolean));
      expect(events.some((e) => e.type === "notice:delivered")).toBe(true);
    });

    it("routes to the active turn's channel when opts.channel is omitted", async () => {
      const { service, transcriptNotice } = makeService();
      const post = vi.fn(async () => {});
      service.register({ tg: { kind: "messenger", deliver: { post } } });
      await service.runWithActive({ channelId: "tg", kind: "messenger", thread: "t1" }, async () => {
        await service.deliverNotice("hi", { informModel: true });
      });
      expect(post).toHaveBeenCalledWith("hi", { kind: "notice", thread: "t1" });
      expect(transcriptNotice).toHaveBeenCalledWith("hi", true);
    });

    it("explicit opts.channel overrides the active channel", async () => {
      const { service } = makeService();
      const post = vi.fn(async () => {});
      service.register({ tg: { kind: "messenger", deliver: { post } } });
      await service.runWithActive({ channelId: "web", kind: "web" }, async () => {
        await service.deliverNotice("hi", { channel: "tg", thread: "t1" });
      });
      expect(post).toHaveBeenCalledWith("hi", { kind: "notice", thread: "t1" });
    });

    it("posts to a delivering channel without writing to the transcript unless informModel is true", async () => {
      const { service, transcriptNotice } = makeService();
      const post = vi.fn(async () => {});
      service.register({ tg: { kind: "messenger", deliver: { post } } });
      await service.deliverNotice("hi", { channel: "tg", thread: "t1" });
      expect(post).toHaveBeenCalled();
      expect(transcriptNotice).not.toHaveBeenCalled();
    });

    it("throws for an unknown explicit channel", async () => {
      const { service } = makeService();
      await expect(service.deliverNotice("hi", { channel: "nope" })).rejects.toThrow();
    });

    it("throws on out-of-turn delivery to a multi-thread channel with no thread", async () => {
      const { service } = makeService();
      const post = vi.fn(async () => {});
      service.register({ tg: { kind: "messenger", deliver: { post } } });
      await expect(service.deliverNotice("hi", { channel: "tg" })).rejects.toThrow();
      expect(post).not.toHaveBeenCalled();
    });

    it("throws on out-of-turn delivery to a voice/custom channel with no deliver hook", async () => {
      const { service } = makeService();
      service.register({ v: { kind: "voice" } });
      await expect(service.deliverNotice("hi", { channel: "v" })).rejects.toThrow();
    });

    it("does not throw for in-turn delivery to a voice/custom channel with no deliver hook", async () => {
      const { service } = makeService();
      service.register({ v: { kind: "voice" } });
      await service.runWithActive({ channelId: "v", kind: "voice" }, async () => {
        await expect(service.deliverNotice("hi")).resolves.not.toThrow();
      });
    });

    it("emits notice:failed and rethrows when the delivery hook throws", async () => {
      const { service, events } = makeService();
      const post = vi.fn(async () => {
        throw new Error("network down");
      });
      service.register({ tg: { kind: "messenger", deliver: { post } } });
      await expect(service.deliverNotice("hi", { channel: "tg", thread: "t1" })).rejects.toThrow("network down");
      expect(events.some((e) => e.type === "notice:failed")).toBe(true);
    });

    it("emits channel:delivered for a final reply delivered to a non-web channel", async () => {
      const { service, events } = makeService();
      const post = vi.fn(async () => {});
      service.register({ tg: { kind: "messenger", deliver: { post } } });
      await service.deliverNotice("done", { channel: "tg", thread: "t1", kind: "final" });
      expect(events.some((e) => e.type === "channel:delivered")).toBe(true);
    });

    it("does not emit channel:delivered for a final notice on the web channel", async () => {
      const { service, events } = makeService();
      await service.deliverNotice("done", { kind: "final" });
      expect(events.some((e) => e.type === "channel:delivered")).toBe(false);
    });
  });

  describe("channel:resolved event", () => {
    it("is emitted when resolve() successfully resolves a registered channel", () => {
      const { service, events } = makeService();
      service.resolve("web");
      expect(events.some((e) => e.type === "channel:resolved")).toBe(true);
    });

    it("is not emitted for an unresolved id", () => {
      const { service, events } = makeService();
      service.resolve("nope");
      expect(events.some((e) => e.type === "channel:resolved")).toBe(false);
    });
  });
});
