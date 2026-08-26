import { describe, expect, it, vi } from "vitest";
import { VoiceProviderError } from "../errors";
import {
  ClientDiagnostics,
  ServerDiagnostics,
  sanitizeDiagnosticData
} from "../diagnostics";

describe("voice diagnostic boundary", () => {
  it("drops content fields and forwards only explicit error metadata", () => {
    const longMessage = `provider failed ${"x".repeat(300)}`;
    const data = sanitizeDiagnosticData({
      transcript: "private transcript",
      prompt: "private prompt",
      messages: "private message",
      tool_name: "private tool",
      arguments: "private arguments",
      result: "private result",
      audio: "private audio",
      raw_body: "private body",
      connection_query: "token=private",
      count: 3,
      outcome: "failed",
      error: new VoiceProviderError(longMessage, {
        code: "provider_unavailable",
        status: 503
      })
    });

    expect(data).toMatchObject({
      count: 3,
      outcome: "failed",
      error: {
        name: "VoiceProviderError",
        code: "provider_unavailable",
        status: 503
      }
    });
    expect(JSON.stringify(data)).not.toMatch(
      /private transcript|private prompt|private message|private tool|private arguments|private audio/
    );
    expect(
      ((data!.error as Record<string, unknown>).message as string).length
    ).toBeLessThanOrEqual(160);
  });

  it("preserves error data already sanitized by the server", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const diagnostics = new ClientDiagnostics();
    diagnostics.setEnabled(true);

    diagnostics.receive({
      event: "stt.fatal",
      timestamp: 123,
      data: {
        error: {
          name: "VoiceProviderError",
          message: "provider unavailable",
          code: "provider_unavailable"
        }
      }
    });

    expect(info).toHaveBeenCalledWith("[voice:server] stt.fatal", {
      timestamp: 123,
      error: {
        name: "VoiceProviderError",
        message: "provider unavailable",
        code: "provider_unavailable"
      }
    });
    info.mockRestore();
  });

  it("isolates diagnostic forwarding failures", () => {
    const diagnostics = new ServerDiagnostics(true);
    const connection = {
      send(): void {
        throw new Error("connection closed");
      }
    };

    expect(() => diagnostics.emit(connection, "call.ready")).not.toThrow();
  });

  it("tracks content-free reasoning spans and first visible text", () => {
    let now = 100;
    const messages: Record<string, unknown>[] = [];
    const diagnostics = new ServerDiagnostics(true);
    const turn = diagnostics.turn(
      {
        send(data): void {
          messages.push(JSON.parse(data as string) as Record<string, unknown>);
        }
      },
      "turn_reasoning",
      "speech",
      () => now
    );
    const model = turn.startModel();

    now = 110;
    model.observe({ type: "reasoning-start" });
    now = 120;
    model.observe({ type: "reasoning-start" });
    now = 140;
    model.observe({ type: "reasoning-end" });
    now = 150;
    model.observe({ type: "reasoning-start" });
    model.observe({ type: "text", text: "visible answer" });
    now = 160;
    model.complete("output", "stop");

    expect(messages.map((message) => message.event)).toEqual([
      "model.started",
      "model.reasoning_started",
      "model.reasoning_completed",
      "model.reasoning_started",
      "model.first_text",
      "model.reasoning_completed",
      "model.completed"
    ]);
    expect(messages[2]).toMatchObject({
      data: {
        turn_id: "turn_reasoning",
        duration_ms: 30,
        outcome: "completed"
      }
    });
    expect(messages[6]).toMatchObject({
      data: {
        turn_id: "turn_reasoning",
        duration_ms: 60,
        outcome: "output",
        characters: 14,
        finish_reason: "stop"
      }
    });
    expect(JSON.stringify(messages)).not.toContain("visible answer");
  });

  it("derives one stable content-free summary from the recorded lifecycle", () => {
    let now = 0;
    const messages: Record<string, unknown>[] = [];
    const diagnostics = new ServerDiagnostics(true);
    const turn = diagnostics.turn(
      {
        send(data): void {
          messages.push(JSON.parse(data as string) as Record<string, unknown>);
        }
      },
      "turn_complete",
      "speech",
      () => now
    );

    turn.emit("turn.started", { source: "speech" });
    turn.speechStarted();
    now = 10;
    turn.firstInterim(12);
    now = 40;
    turn.finalInput(24);
    now = 42;
    turn.recordAfterTranscribe(2, "accepted", 24);

    now = 50;
    const model = turn.startModel();
    now = 60;
    model.observe({ type: "reasoning-start" });
    now = 70;
    model.observe({ type: "reasoning-end" });
    now = 80;
    model.observe({ type: "text", text: "visible" });
    now = 90;
    model.complete("output", "stop");

    now = 100;
    const firstSentence = turn.beginTtsSentence();
    firstSentence.providerStarted();
    now = 110;
    const secondSentence = turn.beginTtsSentence();
    secondSentence.providerStarted();
    now = 130;
    turn.audioSent();
    now = 160;
    secondSentence.settle("completed");
    now = 180;
    firstSentence.settle("completed");
    turn.audioSent();
    turn.finishTts();
    now = 200;
    turn.finish("completed");

    const summary = messages.find((message) => message.type === "turn_metrics");
    expect(summary).toEqual({
      type: "turn_metrics",
      turnId: "turn_complete",
      source: "speech",
      outcome: "completed",
      turnTotalMs: 200,
      speechStartToFirstInterimMs: 10,
      speechStartToFinalMs: 40,
      afterTranscribeMs: 2,
      modelToFirstTextMs: 30,
      exposedReasoningMs: 10,
      modelStreamConsumptionMs: 40,
      finalInputToFirstAudioMs: 90,
      ttsToFirstAudioMs: 30,
      ttsWallMs: 80,
      ttsWorkMs: 130
    });
    expect(
      (summary?.ttsWorkMs as number) > (summary?.ttsWallMs as number)
    ).toBe(true);
    expect(JSON.stringify(summary)).not.toContain("visible answer");
  });

  it("emits every stable terminal outcome", () => {
    const outcomes = [
      "completed",
      "no_output",
      "output_limit",
      "content_filtered",
      "model_error",
      "tts_error",
      "aborted",
      "skipped",
      "error"
    ] as const;

    for (const outcome of outcomes) {
      const messages: Record<string, unknown>[] = [];
      const turn = new ServerDiagnostics(false).turn(
        {
          send(data): void {
            messages.push(
              JSON.parse(data as string) as Record<string, unknown>
            );
          }
        },
        `turn_${outcome}`,
        "text",
        () => 1
      );
      turn.finish(outcome);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        type: "turn_metrics",
        outcome,
        turnId: `turn_${outcome}`
      });
    }
  });

  it("omits lifecycle measurements that were never reached", () => {
    let now = 10;
    const messages: Record<string, unknown>[] = [];
    const turn = new ServerDiagnostics(false).turn(
      {
        send(data): void {
          messages.push(JSON.parse(data as string) as Record<string, unknown>);
        }
      },
      "turn_skipped",
      "text",
      () => now
    );
    turn.markTextInput();
    now = 15;
    turn.finish("skipped");

    expect(messages).toEqual([
      {
        type: "turn_metrics",
        turnId: "turn_skipped",
        source: "text",
        outcome: "skipped",
        turnTotalMs: 5
      }
    ]);
  });

  it("closes unfinished reasoning on finish, error, and abort", () => {
    const outcomes: string[] = [];

    for (const terminal of ["finish", "error", "abort"] as const) {
      let now = 0;
      const diagnostics = new ServerDiagnostics(true);
      const turn = diagnostics.turn(
        {
          send(data): void {
            const message = JSON.parse(data as string) as Record<
              string,
              unknown
            >;
            if (message.event === "model.reasoning_completed") {
              outcomes.push(
                ((message.data as Record<string, unknown>).outcome as string) ??
                  "missing"
              );
            }
          }
        },
        `turn_${terminal}`,
        "speech",
        () => now
      );
      const model = turn.startModel();
      now = 10;
      model.observe({ type: "reasoning-start" });
      now = 25;

      if (terminal === "finish") {
        model.observe({ type: "finish", finishReason: "stop" });
        model.complete("no_output", "stop");
      } else if (terminal === "error") {
        model.fail(new Error("model failed"));
      } else {
        model.abort();
      }
    }

    expect(outcomes).toEqual(["stream_finished", "error", "aborted"]);
  });
});
