import { describe, expect, it, onTestFinished, vi } from "vitest";
import { reportTurnFailure, type TurnFailureHost } from "../turn-failure";

type Message = { id: string; role: string };

function makeHost(recordFails = false) {
  const steps: string[] = [];
  const host: TurnFailureHost<Message> = {
    describe: ({ error }) => {
      steps.push("describe");
      return error instanceof Error ? error.message : String(error);
    },
    recordTerminal: async (requestId) => {
      steps.push(`record:${requestId}`);
      if (recordFails) throw new Error("storage is gone");
    },
    broadcast: (frame) => void steps.push(`frame:${frame.id}:${frame.body}`),
    respond: () => {}
  };
  return { host, steps };
}

const failure = {
  requestId: "cont-1",
  error: new Error("model down"),
  continuation: true
};

describe("reportTurnFailure", () => {
  it("attaches a failed continuation to the latest assistant message", async () => {
    const { host } = makeHost();
    const transcript: Message[] = [
      { id: "u1", role: "user" },
      { id: "a1", role: "assistant" },
      { id: "u2", role: "user" }
    ];

    // The last message is the user's: the reply before it is the one a
    // continuation would have extended.
    expect(await reportTurnFailure(transcript, host, failure)).toEqual({
      message: transcript[1],
      requestId: "cont-1",
      continuation: true,
      status: "error",
      error: "model down"
    });
  });

  it("finds the reply when it is the first message", async () => {
    const { host } = makeHost();
    const transcript: Message[] = [{ id: "a1", role: "assistant" }];

    const result = await reportTurnFailure(transcript, host, failure);
    expect(result?.message).toBe(transcript[0]);
  });

  it("has no response result when the transcript holds no reply", async () => {
    const { host, steps } = makeHost();

    const onlyQuestion: Message[] = [{ id: "u1", role: "user" }];

    expect(
      await reportTurnFailure(onlyQuestion, host, failure)
    ).toBeUndefined();
    expect(await reportTurnFailure([], host, failure)).toBeUndefined();
    // Clients are told all the same.
    expect(steps.filter((step) => step.startsWith("frame:"))).toHaveLength(2);
  });

  it("still sends the error frame when the terminal record cannot be stored", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => logged.mockRestore());
    const { host, steps } = makeHost(true);
    const transcript: Message[] = [{ id: "a1", role: "assistant" }];

    const result = await reportTurnFailure(transcript, host, failure);

    expect(steps).toEqual([
      "describe",
      "record:cont-1",
      "frame:cont-1:model down"
    ]);
    expect(result?.status).toBe("error");
    expect(logged).toHaveBeenCalledTimes(1);
  });
});
