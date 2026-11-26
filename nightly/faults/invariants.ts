// What must hold after every fault scenario, whatever the scenario's own
// outcome: the rules verify checks (one terminal per request, nothing lost,
// nothing left running).

import type { UIMessage } from "ai";
import { MT, recoveryBalance } from "./lib";
import type { Run } from "./scenarios";

function isEmptyAssistant(m: UIMessage): boolean {
  if (m.role !== "assistant") return false;
  return m.parts.every(
    (p) => p.type === "step-start" || (p.type === "text" && !p.text.trim())
  );
}

/** The last assistant message waits on the client: a tool call to answer or approve. */
function awaitsClient(messages: UIMessage[]): boolean {
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  return (last?.parts ?? []).some((p) => {
    const state = (p as { state?: string }).state;
    return (
      (p.type.startsWith("tool-") || p.type === "dynamic-tool") &&
      (state === "input-available" || state === "approval-requested")
    );
  });
}

/** Every rule the run breaks, as one line each. Empty when it is clean. */
export function violations(run: Run): string[] {
  const out: string[] = [];
  const { state } = run;
  if (state.unsettled)
    out.push(
      "did not settle: the transcript or events kept changing, or a recovery stayed open"
    );

  const { detected, ended } = recoveryBalance(state.events);
  if (detected !== ended)
    out.push(`recoveries: ${detected} detected, ${ended} ended`);

  const ids = state.messages.map((m) => m.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length)
    out.push(`duplicate message ids: ${[...new Set(dup)].join(", ")}`);
  if (state.messages.some(isEmptyAssistant))
    out.push("an assistant message with no content");

  run.tabs.forEach((tab, n) => {
    // A `done` frame with outcome `recovering` hands the request to its
    // recovery; it is not the request's end. The end comes once, later,
    // under the request's id or its recovered continuation's.
    const seen = new Set<string>();
    const ends = new Map<string, number>();
    let handedOff = false;
    for (const f of tab.frames) {
      if (f.type !== MT.RESPONSE || !f.done || !f.id) continue;
      seen.add(f.id);
      if (f.outcome === "recovering") handedOff = true;
      else {
        handedOff = false;
        ends.set(f.id, (ends.get(f.id) ?? 0) + 1);
      }
    }
    // A recovery that finds the turn waiting on the client leaves it
    // waiting: the client's answer continues it.
    if (handedOff && !awaitsClient(state.messages))
      out.push(
        `tab ${n}: a request was handed to its recovery and nothing ended after it`
      );
    for (const id of tab.sent) {
      if (!seen.has(id))
        out.push(`tab ${n}: request ${id} never got a done frame`);
    }
    for (const [id, count] of ends) {
      if (count > 1) out.push(`tab ${n}: request ${id} ended ${count} times`);
    }
  });
  return out;
}
