import { NotFoundError, ValidationError } from "../../kernel/errors.js";
import type { EventBus } from "../../kernel/events.js";
import type { ToolSet } from "../tools/types.js";

export type ChannelKind = "web" | "messenger" | "voice" | "custom";

export interface ChannelContext {
  channelId: string;
  kind: ChannelKind;
  thread?: string;
}

export interface ChannelDelivery {
  /** Deliver text out-of-band. `thread` is required for multi-thread surfaces. */
  post(text: string, opts: { kind: "final" | "interim" | "notice" | "command"; thread?: string }): Promise<void>;
}

export interface ChannelDefinition {
  kind: ChannelKind;
  instructions?: string | ((ctx: ChannelContext) => string | Promise<string>);
  /** Filter only — may not add tool names not present in the input. */
  tools?: (all: ToolSet) => ToolSet;
  /** Step cap for turns on this channel. */
  maxTurns?: number;
  capabilities?: { streaming?: boolean; editing?: boolean };
  deliver?: ChannelDelivery;
}

export interface ChannelPolicy {
  instructions?: string;
  toolFilter?: (t: ToolSet) => ToolSet;
  maxTurns?: number;
}

export interface DeliverNoticeOptions {
  channel?: string;
  informModel?: boolean;
  kind?: "final" | "interim" | "notice" | "command";
  thread?: string;
}

export interface ChannelService {
  /** Validates and registers channels; a duplicate id throws. */
  register(channels: Record<string, ChannelDefinition>): void;
  resolve(channelId: string | undefined): ChannelContext | undefined;
  policyFor(channelId: string | undefined): Promise<ChannelPolicy>;
  active(): ChannelContext | undefined;
  runWithActive<T>(ctx: ChannelContext | undefined, fn: () => Promise<T>): Promise<T>;
  deliverNotice(text: string, opts?: DeliverNoticeOptions): Promise<void>;
}

export function createChannelService(deps: {
  bus: EventBus;
  /** Think wires this: append a notice to the transcript (the default sink). */
  transcriptNotice: (text: string, informModel: boolean) => Promise<void>;
}): ChannelService {
  const definitions = new Map<string, ChannelDefinition>();

  // Turns are serialized, so a simple stack scoped to this service instance
  // is sufficient to track the in-flight turn's channel (with safe nesting).
  const activeStack: ChannelContext[] = [];

  function resolve(channelId: string | undefined): ChannelContext | undefined {
    if (channelId === undefined) return undefined;
    const def = definitions.get(channelId);
    if (!def) return undefined;
    return { channelId, kind: def.kind };
  }

  function wrapFilter(channelId: string, filter: (all: ToolSet) => ToolSet): (all: ToolSet) => ToolSet {
    return (all: ToolSet) => {
      const result = filter(all);
      for (const name of Object.keys(result)) {
        if (!(name in all)) {
          throw new ValidationError(
            `channel "${channelId}" tool filter introduced tool "${name}" not present in the input`
          );
        }
      }
      return result;
    };
  }

  return {
    register(channels) {
      for (const [id, def] of Object.entries(channels)) {
        if (definitions.has(id)) {
          throw new ValidationError(`channel id "${id}" is already registered`);
        }
        definitions.set(id, def);
      }
    },

    resolve(channelId) {
      const ctx = resolve(channelId);
      if (ctx) {
        deps.bus.emit("channel:resolved", { channelId: ctx.channelId, kind: ctx.kind });
      }
      return ctx;
    },

    async policyFor(channelId) {
      if (channelId === undefined) return {};
      const def = definitions.get(channelId);
      if (!def) return {};
      const ctx: ChannelContext = { channelId, kind: def.kind };

      const instructions =
        def.instructions === undefined
          ? undefined
          : typeof def.instructions === "function"
            ? await def.instructions(ctx)
            : def.instructions;

      const toolFilter = def.tools ? wrapFilter(channelId, def.tools) : undefined;

      return { instructions, toolFilter, maxTurns: def.maxTurns };
    },

    active() {
      return activeStack[activeStack.length - 1];
    },

    async runWithActive<T>(ctx: ChannelContext | undefined, fn: () => Promise<T>): Promise<T> {
      if (ctx === undefined) return fn();
      activeStack.push(ctx);
      try {
        return await fn();
      } finally {
        activeStack.pop();
      }
    },

    async deliverNotice(text, opts = {}) {
      const current = activeStack[activeStack.length - 1];

      if (opts.channel !== undefined && !definitions.has(opts.channel)) {
        throw new NotFoundError(`unknown channel "${opts.channel}"`);
      }

      const targetId = opts.channel ?? current?.channelId;
      const def = targetId !== undefined ? definitions.get(targetId) : undefined;
      const kind = opts.kind ?? "notice";
      const inTurn = targetId !== undefined && current?.channelId === targetId;
      const thread = opts.thread ?? (inTurn ? current?.thread : undefined);

      // A channel with a `deliver` hook goes out-of-band through it. Everything
      // else — no channel at all, or a channel without a deliver hook — falls back
      // to the transcript, the default sink. There is no privileged "web" channel.
      if (def?.deliver) {
        if (thread === undefined && !inTurn) {
          throw new ValidationError(
            `deliverNotice to channel "${targetId}" requires a thread when delivered out of turn`
          );
        }
        try {
          await def.deliver.post(text, { kind, thread });
        } catch (err) {
          deps.bus.emit("notice:failed", { channel: targetId, kind, error: err instanceof Error ? err.message : String(err) });
          throw err;
        }
        if (opts.informModel === true) {
          await deps.transcriptNotice(text, true);
        }
        deps.bus.emit("notice:delivered", { channel: targetId, kind });
        if (kind === "final") {
          deps.bus.emit("channel:delivered", { channel: targetId });
        }
        return;
      }

      await deps.transcriptNotice(text, opts.informModel ?? true);
      deps.bus.emit("notice:delivered", { channel: targetId ?? "transcript", kind });
    },
  };
}
