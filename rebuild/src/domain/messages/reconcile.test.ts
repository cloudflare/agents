import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./model.js";
import { reconcileIncoming } from "./reconcile.js";

const user = (id: string, text: string): ChatMessage => ({ id, role: "user", parts: [{ type: "text", text }] });
const toolAsst = (id: string, state: "input-available" | "output-available", extra?: object): ChatMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "tool-paint", toolCallId: "call_1", state, input: { p: 1 }, ...(state === "output-available" ? { output: { ok: true } } : {}), ...extra }],
});

describe("reconcileIncoming (ISSUE-015)", () => {
  it("appends genuinely-new messages and skips known unchanged ids", () => {
    const history = [user("u1", "hi")];
    const plan = reconcileIncoming(history, [user("u1", "hi"), user("u2", "more")]);
    expect(plan.toAppend.map((m) => m.id)).toEqual(["u2"]);
    expect(plan.toUpdate).toEqual([]);
  });

  it("collapses an optimistic assistant duplicating a server-owned tool call under a new id", () => {
    const history = [user("u1", "hi"), toolAsst("server", "output-available")];
    const plan = reconcileIncoming(history, [user("u1", "hi"), toolAsst("optimistic", "input-available"), user("u2", "next")]);
    expect(plan.toAppend.map((m) => m.id)).toEqual(["u2"]);
    expect(plan.toUpdate).toEqual([]);
  });

  it("never lets a stale same-id copy downgrade a settled tool part", () => {
    const history = [toolAsst("shared", "output-available")];
    const plan = reconcileIncoming(history, [toolAsst("shared", "input-available")]);
    expect(plan.toAppend).toEqual([]);
    // Merged content equals the stored row (server part wins) -> no update.
    expect(plan.toUpdate).toEqual([]);
  });

  it("updates a known id when the incoming copy genuinely advances it", () => {
    const history = [toolAsst("shared", "input-available")];
    const plan = reconcileIncoming(history, [toolAsst("shared", "output-available")]);
    expect(plan.toUpdate.map((m) => m.id)).toEqual(["shared"]);
  });

  it("does not collapse an assistant whose tool calls are unknown to history", () => {
    const history = [user("u1", "hi")];
    const incoming = toolAsst("fresh", "output-available");
    const plan = reconcileIncoming(history, [incoming]);
    expect(plan.toAppend.map((m) => m.id)).toEqual(["fresh"]);
  });
});
