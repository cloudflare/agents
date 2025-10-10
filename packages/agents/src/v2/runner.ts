import type { Provider } from "./providers";
import type { AgentMiddleware, AgentState, ModelRequest } from "./types";

export type StepVerdict =
  | { kind: "continue"; state: AgentState }
  | {
      kind: "paused";
      state: AgentState;
      reason: "hitl" | "exhausted" | "subagent";
    }
  | { kind: "done"; state: AgentState }
  | { kind: "error"; state: AgentState; error: Error };

export async function step(
  provider: Provider,
  middleware: AgentMiddleware[],
  s: AgentState
): Promise<StepVerdict> {
  // 1) beforeModel
  let state = s;
  try {
    for (const m of middleware) {
      const up = await m.beforeModel?.(state);
      if (up) state = { ...state, ...up };
      if (state.jumpTo === "tools" || state.jumpTo === "end") break;
    }

    // 2) compose ModelRequest
    let req: ModelRequest = {
      model: state.meta?.model ?? "openai:gpt-4.1",
      systemPrompt: state.meta?.systemPrompt,
      messages: state.messages.filter((m) => m.role !== "system"),
      toolDefs: state.meta?.toolDefs ?? []
    };

    for (const m of middleware)
      req = await (m.modifyModelRequest?.(req, state) ?? req);

    console.log("req", JSON.stringify(req.messages, null, 2));
    const res = await provider.invoke(req, {});
    console.log("res", JSON.stringify(res.message, null, 2));
    state = { ...state, messages: [...state.messages, res.message] };

    // 4) afterModel (HITL / guardrails may pause)
    for (const m of [...middleware].reverse()) {
      const up = await m.afterModel?.(state);
      if (up) state = { ...state, ...up };
    }

    // If HITL flagged pending tool calls, pause now
    if (state.meta?.pendingToolCalls?.length) {
      return { kind: "paused", state, reason: "hitl" };
    }

    // If assistant proposed tool calls, the outer scheduler will execute them and then call runStep again.
    // If no tool calls, we consider that a completion signal when the assistant doesn't have more to do.
    const last = state.messages[state.messages.length - 1];
    const hasCalls =
      last?.role === "assistant" &&
      "tool_calls" in last &&
      Array.isArray(last.tool_calls) &&
      last.tool_calls.length > 0;

    return hasCalls ? { kind: "continue", state } : { kind: "done", state };
  } catch (e: unknown) {
    return { kind: "error", state, error: e as Error };
  }
}
