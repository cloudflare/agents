import { describe, expect, it } from "vitest";
import {
  buildPipelineSchema,
  type PipelineSchemaConfig
} from "../../realtime/pipeline-schema";
import {
  DataKind,
  DeepgramSTT,
  ElevenLabsTTS,
  RealtimeKitTransport,
  WebSocketTransport,
  type WebSocketPipelineComponent
} from "../../realtime/components";

/**
 * Minimal stand-in for RealtimeAgent's WebSocketPipelineComponent interface.
 * RealtimeAgent can't be instantiated in tests (requires DurableObject context),
 * but buildPipelineSchema only uses the component interface and matches the
 * agent via constructor.name === parentClassName.
 */
class TestAgent implements WebSocketPipelineComponent {
  name = "agent";
  url?: string;
  input_kind() {
    return [DataKind.Text, DataKind.Audio, DataKind.Video];
  }
  output_kind() {
    return [DataKind.Text, DataKind.Audio, DataKind.Video];
  }
  schema() {
    return {
      name: this.name,
      type: "websocket",
      send_events: true,
      url: this.url!
    };
  }
}

describe("buildPipelineSchema", () => {
  const defaultConfig: Omit<PipelineSchemaConfig, "pipeline"> = {
    agentUrl: "example.com/agents/test-agent/123/realtime",
    parentClassName: "TestAgent",
    meetingId: "test-meeting-123"
  };

  describe("validation", () => {
    it("should throw when adjacent components have mismatched kinds", () => {
      // DeepgramSTT outputs Text, but another DeepgramSTT expects Audio input
      const pipeline = [new DeepgramSTT(), new DeepgramSTT()];

      expect(() => buildPipelineSchema({ ...defaultConfig, pipeline })).toThrow(
        "Cannot link component of output kind TEXT with input kind AUDIO"
      );
    });

    it("should handle empty pipeline", () => {
      const result = buildPipelineSchema({ ...defaultConfig, pipeline: [] });
      expect(result.elements).toEqual([]);
      expect(result.layers).toEqual([]);
      expect(result.realtimeKitComponent).toBeUndefined();
    });
  });

  describe("RealtimeKit transport", () => {
    it("should throw when meeting ID is missing", () => {
      const rtk = new RealtimeKitTransport();
      expect(() =>
        buildPipelineSchema({
          ...defaultConfig,
          pipeline: [rtk],
          meetingId: null
        })
      ).toThrow("Meeting ID not set for RealtimeKit transport");
    });

    it("should set meeting ID from config and add worker_url", () => {
      const rtk = new RealtimeKitTransport();
      const result = buildPipelineSchema({
        ...defaultConfig,
        pipeline: [rtk],
        meetingId: "cfg-meeting"
      });

      expect(rtk.meetingId).toBe("cfg-meeting");
      const el = result.elements.find((e) => e.name === "realtime_kit");
      expect(el?.meeting_id).toBe("cfg-meeting");
      expect(el?.worker_url).toBe(`https://${defaultConfig.agentUrl}`);
    });

    it("should return realtimeKitComponent ref when no auth token, omit when set", () => {
      const noAuth = new RealtimeKitTransport({ meetingId: "t" });
      const withAuth = new RealtimeKitTransport({
        meetingId: "t",
        authToken: "tok"
      });

      const r1 = buildPipelineSchema({
        ...defaultConfig,
        pipeline: [noAuth]
      });
      const r2 = buildPipelineSchema({
        ...defaultConfig,
        pipeline: [withAuth]
      });

      expect(r1.realtimeKitComponent).toBe(noAuth);
      expect(r2.realtimeKitComponent).toBeUndefined();
    });
  });

  describe("element handling", () => {
    it("should configure agent as websocket element with url and send_events", () => {
      const agent = new TestAgent();
      const result = buildPipelineSchema({
        ...defaultConfig,
        pipeline: [agent]
      });

      const el = result.elements.find((e) => e.name === "agent");
      expect(el?.type).toBe("websocket");
      expect(el?.send_events).toBe(true);
      expect(el?.url).toBe(`wss://${defaultConfig.agentUrl}/ws`);
    });

    it("should deduplicate elements by name", () => {
      const rtk = new RealtimeKitTransport({ meetingId: "test" });
      const pipeline = [
        rtk,
        new DeepgramSTT(),
        new TestAgent(),
        new ElevenLabsTTS(),
        rtk
      ];

      const result = buildPipelineSchema({ ...defaultConfig, pipeline });
      const rtkCount = result.elements.filter(
        (e) => e.name === "realtime_kit"
      ).length;
      expect(rtkCount).toBe(1);
    });
  });

  describe("split at agent (passing this)", () => {
    it("should split [RTK, STT, Agent, TTS, RTK] into input and output layers", () => {
      const rtk = new RealtimeKitTransport({ meetingId: "test" });
      const pipeline = [
        rtk,
        new DeepgramSTT(),
        new TestAgent(),
        new ElevenLabsTTS(),
        rtk
      ];

      const result = buildPipelineSchema({ ...defaultConfig, pipeline });

      expect(result.layers.length).toBe(2);

      // Input layer: rtk -> stt -> agent, filter from DeepgramSTT input (Audio)
      expect(result.layers[0].elements).toEqual([
        "realtime_kit",
        "transcription_deepgram",
        "agent"
      ]);
      expect(result.layers[0].filters).toEqual([{ media_kind: "audio" }]);

      // Output layer: agent -> tts -> rtk, filter from ElevenLabsTTS input_kind (Text)
      expect(result.layers[1].elements).toEqual([
        "agent",
        "tts_elevenlabs",
        "realtime_kit"
      ]);
      expect(result.layers[1].filters).toEqual([{ media_kind: "text" }]);
    });

    it("should split [RTK, Agent, RTK] without STT/TTS", () => {
      const rtk = new RealtimeKitTransport({ meetingId: "test" });
      const pipeline = [rtk, new TestAgent(), rtk];

      const result = buildPipelineSchema({ ...defaultConfig, pipeline });

      expect(result.layers.length).toBe(2);
      expect(result.layers[0].elements).toEqual(["realtime_kit", "agent"]);
      expect(result.layers[1].elements).toEqual(["agent", "realtime_kit"]);
      // 2nd element is TestAgent, input_kind = [Text, Audio, Video] → all kinds
      expect(result.layers[0].filters).toEqual([
        { media_kind: "text" },
        { media_kind: "audio" },
        { media_kind: "video" }
      ]);
      // Output layer 2nd element is RTK, output_kind = [Audio, Video]
      expect(result.layers[1].filters).toEqual([
        { media_kind: "audio" },
        { media_kind: "video" }
      ]);
    });

    it("should not split when agent is at the end", () => {
      const rtk = new RealtimeKitTransport({ meetingId: "test" });
      const pipeline = [rtk, new DeepgramSTT(), new TestAgent()];

      const result = buildPipelineSchema({ ...defaultConfig, pipeline });

      expect(result.layers.length).toBe(1);
      expect(result.layers[0].elements).toEqual([
        "realtime_kit",
        "transcription_deepgram",
        "agent"
      ]);
      expect(result.layers[0].filters).toEqual([{ media_kind: "audio" }]);
    });

    it("should not split when agent is at the start", () => {
      const rtk = new RealtimeKitTransport({ meetingId: "test" });
      const pipeline = [new TestAgent(), new ElevenLabsTTS(), rtk];

      const result = buildPipelineSchema({ ...defaultConfig, pipeline });

      expect(result.layers.length).toBe(1);
      expect(result.layers[0].elements).toEqual([
        "agent",
        "tts_elevenlabs",
        "realtime_kit"
      ]);
      // 2nd element is ElevenLabsTTS, input_kind = [Text] → text filter
      expect(result.layers[0].filters).toEqual([{ media_kind: "text" }]);
    });

    it("should add video layer when consumeVideo is enabled", () => {
      const rtk = new RealtimeKitTransport({
        meetingId: "test",
        media: { consumeVideo: true }
      });
      const pipeline = [
        rtk,
        new DeepgramSTT(),
        new TestAgent(),
        new ElevenLabsTTS(),
        rtk
      ];

      const result = buildPipelineSchema({ ...defaultConfig, pipeline });

      // 2 audio split layers + 1 video = 3
      expect(result.layers.length).toBe(3);

      const videoLayers = result.layers.filter((l) =>
        l.filters?.some((f) => f.media_kind === "video")
      );
      expect(videoLayers.length).toBe(1);
      expect(videoLayers[0].elements).toEqual(["realtime_kit", "agent"]);
    });

    it("should use RTK media config even when authToken is set", () => {
      const rtk = new RealtimeKitTransport({
        meetingId: "test",
        authToken: "tok",
        media: { consumeVideo: true }
      });
      const pipeline = [
        rtk,
        new DeepgramSTT(),
        new TestAgent(),
        new ElevenLabsTTS(),
        rtk
      ];

      const result = buildPipelineSchema({ ...defaultConfig, pipeline });

      // realtimeKitComponent should be undefined (has auth token)
      expect(result.realtimeKitComponent).toBeUndefined();

      // But video layer should still be created from RTK's media config
      const videoLayers = result.layers.filter((l) =>
        l.filters?.some((f) => f.media_kind === "video")
      );
      expect(videoLayers.length).toBe(1);
    });
  });

  describe("split at WebSocketTransport", () => {
    it("should split [STT, WebSocketTransport, TTS] into input and output layers", () => {
      const pipeline = [
        new DeepgramSTT(),
        new WebSocketTransport(new TestAgent()),
        new ElevenLabsTTS()
      ];

      const result = buildPipelineSchema({ ...defaultConfig, pipeline });

      expect(result.layers.length).toBe(2);

      // Input layer: stt -> agent
      // 2nd element is WS(TestAgent), input_kind = [Text, Audio, Video]
      expect(result.layers[0].elements).toEqual([
        "transcription_deepgram",
        "agent"
      ]);
      expect(result.layers[0].filters).toEqual([
        { media_kind: "text" },
        { media_kind: "audio" },
        { media_kind: "video" }
      ]);

      // Output layer: agent -> tts
      // 2nd element is ElevenLabsTTS, input_kind = [Text]
      expect(result.layers[1].elements).toEqual(["agent", "tts_elevenlabs"]);
      expect(result.layers[1].filters).toEqual([{ media_kind: "text" }]);
    });

    it("should split [RTK, WebSocketTransport, TTS, RTK] into input and output layers", () => {
      const rtk = new RealtimeKitTransport({ meetingId: "test" });
      const pipeline = [
        rtk,
        new WebSocketTransport(new TestAgent()),
        new ElevenLabsTTS(),
        rtk
      ];

      const result = buildPipelineSchema({ ...defaultConfig, pipeline });

      expect(result.layers.length).toBe(2);
      expect(result.layers[0].elements).toEqual(["realtime_kit", "agent"]);
      expect(result.layers[1].elements).toEqual([
        "agent",
        "tts_elevenlabs",
        "realtime_kit"
      ]);
    });

    it("should not split when WebSocketTransport is at the end", () => {
      const pipeline = [
        new DeepgramSTT(),
        new WebSocketTransport(new TestAgent())
      ];

      const result = buildPipelineSchema({ ...defaultConfig, pipeline });

      expect(result.layers.length).toBe(1);
      expect(result.layers[0].elements).toEqual([
        "transcription_deepgram",
        "agent"
      ]);
    });

    it("should not split when WebSocketTransport is at the start", () => {
      const pipeline = [
        new WebSocketTransport(new TestAgent()),
        new ElevenLabsTTS()
      ];

      const result = buildPipelineSchema({ ...defaultConfig, pipeline });

      expect(result.layers.length).toBe(1);
      expect(result.layers[0].elements).toEqual(["agent", "tts_elevenlabs"]);
    });

    it("should configure wrapped component as websocket element", () => {
      const agent = new TestAgent();
      const pipeline = [new DeepgramSTT(), new WebSocketTransport(agent)];

      const result = buildPipelineSchema({ ...defaultConfig, pipeline });

      const el = result.elements.find((e) => e.name === "agent");
      expect(el?.type).toBe("websocket");
      expect(el?.send_events).toBe(true);
      expect(el?.url).toBe(`wss://${defaultConfig.agentUrl}/ws`);
    });

    it("should split at agent when websocket transport is at edges", () => {
      const agent = new TestAgent();
      const ws = new WebSocketTransport(agent);
      const pipeline = [ws, new DeepgramSTT(), agent, new ElevenLabsTTS(), ws];
      const result = buildPipelineSchema({ ...defaultConfig, pipeline });

      expect(result.layers.length).toBe(2);

      // Agent element: websocket config from TestAgent
      const agentEl = result.elements.find((e) => e.name === "agent");
      expect(agentEl?.type).toBe("websocket");
      expect(agentEl?.url).toBe(`wss://${defaultConfig.agentUrl}/ws`);
      expect(agentEl?.send_events).toBe(true);

      // Split at agent (index 2), which has elements on both sides
      expect(result.layers[0].elements).toEqual([
        "agent",
        "transcription_deepgram",
        "agent"
      ]);
      expect(result.layers[0].filters).toEqual([{ media_kind: "audio" }]);

      expect(result.layers[1].elements).toEqual([
        "agent",
        "tts_elevenlabs",
        "agent"
      ]);
      expect(result.layers[1].filters).toEqual([{ media_kind: "text" }]);
    });

    it("should split at multiple websocket/agent boundaries", () => {
      const rtk = new RealtimeKitTransport({ meetingId: "test" });
      const agent = new TestAgent();
      const ws = new WebSocketTransport(agent);
      // [RTK, STT, Agent, TTS, WS(agent), RTK]
      // Split points: Agent at index 2, WS at index 4 — both have elements on both sides
      // (WS at index 4: has TTS before, RTK after)
      const pipeline = [
        rtk,
        new DeepgramSTT(),
        agent,
        new ElevenLabsTTS(),
        ws,
        rtk
      ];

      const result = buildPipelineSchema({ ...defaultConfig, pipeline });

      // 3 layers: [RTK, STT, Agent], [Agent, TTS, WS], [WS, RTK]
      expect(result.layers.length).toBe(3);

      expect(result.layers[0].elements).toEqual([
        "realtime_kit",
        "transcription_deepgram",
        "agent"
      ]);
      expect(result.layers[0].filters).toEqual([{ media_kind: "audio" }]);

      expect(result.layers[1].elements).toEqual([
        "agent",
        "tts_elevenlabs",
        "agent"
      ]);
      expect(result.layers[1].filters).toEqual([{ media_kind: "text" }]);

      expect(result.layers[2].elements).toEqual(["agent", "realtime_kit"]);
      expect(result.layers[2].filters).toEqual([
        { media_kind: "audio" },
        { media_kind: "video" }
      ]);
    });
  });
});
