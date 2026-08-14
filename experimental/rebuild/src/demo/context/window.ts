/**
 * DEMO MODULE — ContextAssembler, the baseline.
 *
 * A rolling window: the newest N message entries, in order, plus a system
 * prompt. This file is the whole module — the point is that a context
 * strategy is ~25 lines of pure read over LogView.query, and everything the
 * window drops is still on the log for a different assembler to find.
 */

import type { ContextAssembler, MessagePayload } from "../../contract.js";

export function rollingWindow(
  opts: { system?: string; size?: number } = {}
): ContextAssembler {
  return {
    async assemble(input) {
      const newestFirst = await input.view.query({
        kinds: ["message"],
        limit: opts.size ?? 50
      });
      return {
        ...(opts.system !== undefined ? { system: opts.system } : {}),
        messages: [...newestFirst].reverse().map((entry) => {
          const m = entry.payload as MessagePayload;
          return { role: m.role, parts: m.parts };
        }),
        tools: input.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input: t.input
        }))
      };
    }
  };
}
