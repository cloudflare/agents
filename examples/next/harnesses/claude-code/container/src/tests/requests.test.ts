/**
 * The parked-request table answers for the human when nobody does: the
 * reply it invents must be the shape the waiting caller expects, or a tool
 * call would read a permission verdict as its output.
 */
import { describe, expect, it } from "vitest";
import type {
  HarnessReply,
  HarnessRequestDraft
} from "../../../shared/src/types.ts";
import { RequestRegistry } from "../engine.ts";

function registry() {
  const closed: { requestId: string; by: string; reply?: HarnessReply }[] = [];
  const requests = new RequestRegistry({
    onOpen: () => {},
    onClose: (requestId, by, reply) => closed.push({ requestId, by, reply }),
    defaultTimeoutMs: 1_000
  });
  return { requests, closed };
}

const tool: HarnessRequestDraft = {
  type: "tool",
  requestId: "req-tool",
  operationId: "op-1",
  toolCallId: "call-1",
  toolName: "lookup",
  input: { key: "value" }
};

const question: HarnessRequestDraft = {
  type: "question",
  requestId: "req-q",
  operationId: "op-1",
  questions: [{ header: "Pick", question: "Which?", options: [{ label: "a" }] }]
};

describe("RequestRegistry", () => {
  it("times out each request in its own reply shape", async () => {
    const { requests, closed } = registry();
    const answers = Promise.all([requests.open(tool), requests.open(question)]);
    requests.sweep(Date.now() + 10_000);
    const [toolReply, questionReply] = await answers;
    expect(toolReply).toEqual({
      type: "tool",
      output: { error: "Timed out waiting for an answer" },
      isError: true
    });
    expect(questionReply).toEqual({
      type: "question",
      answers: null,
      message: "Timed out waiting for an answer"
    });
    expect(closed.map((entry) => entry.by)).toEqual(["timeout", "timeout"]);
  });

  it("fails what is still parked at shutdown in the same shapes", async () => {
    const { requests } = registry();
    const pending = requests.open(tool);
    requests.drain("daemon stopping");
    expect(await pending).toEqual({
      type: "tool",
      output: { error: "daemon stopping" },
      isError: true
    });
    expect(requests.size).toBe(0);
  });
});
