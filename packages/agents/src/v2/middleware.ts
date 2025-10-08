import type { AgentMiddleware, ToolCall } from "./types";

export function vfs(): AgentMiddleware {
  return {
    name: "vfs",
    tools: {
      ls: async (_: unknown, ctx) => Object.keys(ctx.state.files ?? {}),
      read_file: async (p: { path: string }, ctx) =>
        ctx.state.files?.[p.path] ?? "",
      write_file: async (p: { path: string; content: string }, ctx) => {
        ctx.state.files = { ...(ctx.state.files ?? {}), [p.path]: p.content };
        return "ok";
      },
      edit_file: async (
        p: { path: string; find: string; replace: string },
        ctx
      ) => {
        const cur = ctx.state.files?.[p.path] ?? "";
        const next = cur.replaceAll(p.find, p.replace);
        ctx.state.files = { ...(ctx.state.files ?? {}), [p.path]: next };
        return "ok";
      }
    }
  };
}

export function hitl(opts: { interceptTools: string[] }): AgentMiddleware {
  return {
    name: "hitl",
    async afterModel(state) {
      const last = state.messages[state.messages.length - 1];
      const calls =
        last?.role === "assistant" && "tool_calls" in last
          ? (last.tool_calls ?? [])
          : [];
      const risky = calls.find((c: ToolCall) =>
        opts.interceptTools.includes(c.name)
      );
      if (risky) {
        // stash pending tool calls and pause
        return {
          meta: { ...state.meta, pendingToolCalls: calls },
          jumpTo: "end" as const
        };
      }
    }
  };
}
