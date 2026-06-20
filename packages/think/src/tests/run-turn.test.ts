import { env } from "cloudflare:workers";
import { getServerByName } from "partyserver";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import type { ThinkProgrammaticTestAgent } from "./agents/think-session";
import type { SubmitMessagesResult, TurnResult } from "../think";

function textPart(message: { parts?: Array<{ type: string; text?: string }> }) {
  return message.parts?.find((part) => part.type === "text");
}

async function freshProgrammaticAgent(name: string) {
  return getServerByName(
    env.ThinkProgrammaticTestAgent as unknown as DurableObjectNamespace<ThinkProgrammaticTestAgent>,
    `${name}-${crypto.randomUUID()}`
  );
}

describe("Think — runTurn", () => {
  it("wait mode returns TurnResult equivalent to saveMessages", async () => {
    const agent = await freshProgrammaticAgent("runturn-wait-parity");
    await agent.setProgrammaticResponseForTest("RunTurn wait reply");

    const result = (await agent.testRunTurnWaitString(
      "Hello via runTurn"
    )) as TurnResult;

    expect(result.status).toBe("completed");
    expect(result.continuation).toBe(false);
    expect(result.requestId).toBeTruthy();
    expect(result.message?.role).toBe("assistant");
    expect(textPart(result.message ?? {})).toMatchObject({
      type: "text",
      text: "RunTurn wait reply"
    });

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("wait mode supports array input", async () => {
    const agent = await freshProgrammaticAgent("runturn-wait-array");
    await agent.setProgrammaticResponseForTest("Array reply");

    const result = (await agent.testRunTurnWait({
      input: [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: "Array input" }]
        }
      ]
    })) as TurnResult;
    expect(result.status).toBe("completed");
    expect((await agent.getStoredMessages()) as UIMessage[]).toHaveLength(2);
  });

  it("wait mode supports function input", async () => {
    const agent = await freshProgrammaticAgent("runturn-wait-fn");
    await agent.testChat("Seed history");
    await agent.setProgrammaticResponseForTest("Function reply");

    const fnResult = (await agent.testRunTurnWaitWithFn(
      "Function input"
    )) as TurnResult;
    expect(fnResult.status).toBe("completed");

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(4);
  });

  it("wait mode skips empty string and empty array without running a turn", async () => {
    const agent = await freshProgrammaticAgent("runturn-wait-empty");

    const emptyString = (await agent.testRunTurnWait({
      input: ""
    })) as TurnResult;
    expect(emptyString).toEqual({
      requestId: "",
      status: "skipped",
      continuation: false
    });

    const emptyArray = (await agent.testRunTurnWait({
      input: [] as UIMessage[]
    })) as TurnResult;
    expect(emptyArray).toEqual({
      requestId: "",
      status: "skipped",
      continuation: false
    });

    expect(await agent.getStoredMessages()).toHaveLength(0);
  });

  it("continuation mode delegates to continueLastTurn", async () => {
    const agent = await freshProgrammaticAgent("runturn-continuation");
    await agent.setProgrammaticResponseForTest("First answer");

    await agent.testRunTurnWaitString("Start");
    await agent.setProgrammaticResponseForTest("Continued answer");

    const result = (await agent.testRunTurnContinuation()) as TurnResult;
    expect(result.status).toBe("completed");
    expect(result.continuation).toBe(true);
    expect(textPart(result.message ?? {})).toMatchObject({
      type: "text",
      text: "Continued answer"
    });

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "assistant"
    ]);
  });

  it("continuation skips when latest leaf is not assistant", async () => {
    const agent = await freshProgrammaticAgent("runturn-continuation-skip");
    const result = (await agent.testRunTurnContinuation()) as TurnResult;
    expect(result).toMatchObject({
      requestId: "",
      status: "skipped",
      continuation: true
    });
    expect(result.message).toBeUndefined();
  });

  it("submit mode returns SubmitMessagesResult equivalent to submitMessages", async () => {
    const agent = await freshProgrammaticAgent("runturn-submit-parity");

    const result = (await agent.testRunTurnSubmit("Queued prompt", {
      submissionId: "sub-runturn-1",
      metadata: { source: "runTurn" }
    })) as SubmitMessagesResult;

    expect(result.accepted).toBe(true);
    expect(result.submissionId).toBe("sub-runturn-1");
    expect(result.status).toBe("pending");
    expect(result.metadata).toEqual({ source: "runTurn" });
  });

  it("stream mode drives callback and resolves void like chat", async () => {
    const agent = await freshProgrammaticAgent("runturn-stream-parity");
    await agent.setProgrammaticResponseForTest("Streamed via runTurn");

    const result = await agent.testRunTurnStream("Stream me");
    expect(result.done).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.events.length).toBeGreaterThan(0);

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(2);
    expect(textPart(messages[1] ?? {})).toMatchObject({
      type: "text",
      text: "Streamed via runTurn"
    });
  });

  it("validates input vs continuation for wait mode", async () => {
    const agent = await freshProgrammaticAgent("runturn-validate-wait");

    const invalidMode = await agent.testRunTurnExpectError({
      mode: "bogus",
      input: "hi"
    });
    expect(invalidMode?.name).toBe("TypeError");
    expect(invalidMode?.message).toContain("mode must be");

    const neither = await agent.testRunTurnExpectError({ mode: "wait" });
    expect(neither?.name).toBe("TypeError");
    expect(neither?.message).toContain("either input or continuation");

    const both = await agent.testRunTurnExpectError({
      mode: "wait",
      input: "hi",
      continuation: true
    });
    expect(both?.name).toBe("TypeError");
    expect(both?.message).toContain("not both");
  });

  it("validates submit and stream require input", async () => {
    const agent = await freshProgrammaticAgent("runturn-validate-input");

    const submitMissing = await agent.testRunTurnExpectError({
      mode: "submit"
    });
    expect(submitMissing?.name).toBe("TypeError");
    expect(submitMissing?.message).toContain('mode "submit" requires input');

    const streamMissing = await agent.testRunTurnExpectError({
      mode: "stream",
      callback: {
        onStart() {},
        onEvent() {},
        onDone() {},
        onError() {}
      }
    });
    expect(streamMissing?.name).toBe("TypeError");
    expect(streamMissing?.message).toContain('mode "stream" requires input');
  });

  it("validates stream requires callback and rejects unsupported input shapes", async () => {
    const agent = await freshProgrammaticAgent("runturn-validate-stream");

    const noCallback = await agent.testRunTurnExpectError({
      mode: "stream",
      input: "hi"
    });
    expect(noCallback?.name).toBe("TypeError");
    expect(noCallback?.message).toContain('mode "stream" requires callback');

    const continuationOnStream = await agent.testRunTurnExpectError({
      mode: "stream",
      input: "hi",
      continuation: true,
      callback: {
        onStart() {},
        onEvent() {},
        onDone() {},
        onError() {}
      }
    });
    expect(continuationOnStream?.name).toBe("TypeError");
    expect(continuationOnStream?.message).toContain("continuation");

    const arrayInput = await agent.testRunTurnStreamWithArray();
    expect(arrayInput?.message).toContain("array input");

    const fnSubmit = await agent.testRunTurnSubmitWithFunction();
    expect(fnSubmit?.message).toContain("function input");
  });

  it("concurrent non-nested wait enqueues behind an active turn", async () => {
    const agent = await freshProgrammaticAgent("runturn-concurrent-wait");
    await agent.setDelayedChunkResponse(
      ["active ", "turn ", "still ", "running"],
      50
    );
    await agent.setProgrammaticResponseForTest("Queued wait reply");

    const activeTurn = agent.testChat("active turn");
    for (let attempt = 0; attempt < 80; attempt++) {
      const messages = (await agent.getStoredMessages()) as UIMessage[];
      if (
        messages.some(
          (message) =>
            message.role === "user" &&
            message.parts.some(
              (part) => part.type === "text" && part.text === "active turn"
            )
        )
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const queued = (await agent.testRunTurnWaitString(
      "queued wait"
    )) as TurnResult;
    expect(queued.status).toBe("completed");
    expect(queued.continuation).toBe(false);

    await activeTurn;

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages.length).toBeGreaterThanOrEqual(4);
  });
});
