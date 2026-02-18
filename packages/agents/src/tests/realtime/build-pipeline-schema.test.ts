import { describe, expect, it } from "vitest";
import {
  buildPipelineSchema,
  type PipelineSchemaConfig
} from "../../realtime/pipeline-schema";
import {
  DataKind,
  RealtimeKitTransport,
  type RealtimePipelineComponent
} from "../../realtime/components";

/**
 * Creates a mock pipeline component for testing
 */
function createMockComponent(
  name: string,
  inputKind: DataKind[],
  outputKind: DataKind[],
  type = "mock"
): RealtimePipelineComponent {
  return {
    name,
    input_kind: () => inputKind,
    output_kind: () => outputKind,
    schema: () => ({ name, type })
  };
}

/**
 * Creates a mock STT component (Audio -> Text)
 */
function createMockSTT(name = "mock_stt"): RealtimePipelineComponent {
  return createMockComponent(
    name,
    [DataKind.Audio],
    [DataKind.Text],
    "speech_to_text"
  );
}

/**
 * Creates a mock TTS component (Text -> Audio)
 */
function createMockTTS(name = "mock_tts"): RealtimePipelineComponent {
  return createMockComponent(
    name,
    [DataKind.Text],
    [DataKind.Audio],
    "text_to_speech"
  );
}

/**
 * Creates a mock Agent component (Text -> Text)
 * Identified as the agent via constructor.name matching parentClassName in config
 */
class MockAgent implements RealtimePipelineComponent {
  name = "agent";
  input_kind() {
    return [DataKind.Text];
  }
  output_kind() {
    return [DataKind.Text];
  }
  schema() {
    return { name: this.name, type: "websocket" };
  }
}

/**
 * Creates a mock Agent component that accepts any input (for video/audio direct paths)
 * Used for testing scenarios where RTK connects directly to Agent.
 * Tests using this class must pass parentClassName: "MockMediaAgent" in config.
 */
class MockMediaAgent implements RealtimePipelineComponent {
  name = "agent";
  constructor(
    private inputDataKind: DataKind[] = [DataKind.Audio],
    private outputDataKind: DataKind[] = [DataKind.Audio]
  ) {}
  input_kind() {
    return this.inputDataKind;
  }
  output_kind() {
    return this.outputDataKind;
  }
  schema() {
    return { name: this.name, type: "websocket" };
  }
}

describe("buildPipelineSchema", () => {
  const defaultConfig: Omit<PipelineSchemaConfig, "pipeline"> = {
    agentUrl: "example.com/agents/test-agent/123/realtime",
    parentClassName: "MockAgent",
    meetingId: "test-meeting-123"
  };

  describe("component chain validation", () => {
    it("should throw error when component output doesn't match next component input", () => {
      const pipeline = [
        createMockComponent("comp1", [DataKind.Audio], [DataKind.Audio]),
        createMockComponent("comp2", [DataKind.Text], [DataKind.Text]) // Mismatch: expects Text but previous outputs Audio
      ];

      expect(() => buildPipelineSchema({ ...defaultConfig, pipeline })).toThrow(
        "Cannot link component of output kind AUDIO with input kind TEXT"
      );
    });

    it("should not throw when component chain is valid", () => {
      const pipeline = [
        createMockComponent("comp1", [DataKind.Audio], [DataKind.Text]),
        createMockComponent("comp2", [DataKind.Text], [DataKind.Audio])
      ];

      expect(() =>
        buildPipelineSchema({ ...defaultConfig, pipeline })
      ).not.toThrow();
    });

    it("should allow single component pipeline", () => {
      const pipeline = [
        createMockComponent("comp1", [DataKind.Audio], [DataKind.Audio])
      ];

      expect(() =>
        buildPipelineSchema({ ...defaultConfig, pipeline })
      ).not.toThrow();
    });
  });

  describe("RealtimeKit transport handling", () => {
    it("should throw error when RealtimeKit transport has no meeting ID", () => {
      const rtk = new RealtimeKitTransport(); // No meetingId
      const pipeline = [rtk];

      expect(() =>
        buildPipelineSchema({ ...defaultConfig, pipeline, meetingId: null })
      ).toThrow("Meeting ID not set for RealtimeKit transport");
    });

    it("should set meeting ID from config on RealtimeKit transport", () => {
      const rtk = new RealtimeKitTransport();
      const pipeline = [rtk];

      const result = buildPipelineSchema({
        ...defaultConfig,
        pipeline,
        meetingId: "config-meeting-id"
      });

      expect(rtk.meetingId).toBe("config-meeting-id");
      const rtkElement = result.elements.find((e) => e.name === "realtime_kit");
      expect(rtkElement?.meeting_id).toBe("config-meeting-id");
    });

    it("should use existing meeting ID if already set on transport", () => {
      const rtk = new RealtimeKitTransport({ meetingId: "preset-meeting-id" });
      const pipeline = [rtk];

      const result = buildPipelineSchema({
        ...defaultConfig,
        pipeline,
        meetingId: null
      });

      expect(rtk.meetingId).toBe("preset-meeting-id");
      const rtkElement = result.elements.find((e) => e.name === "realtime_kit");
      expect(rtkElement?.meeting_id).toBe("preset-meeting-id");
    });

    it("should add worker_url to RealtimeKit schema", () => {
      const rtk = new RealtimeKitTransport({ meetingId: "test" });
      const pipeline = [rtk];

      const result = buildPipelineSchema({ ...defaultConfig, pipeline });

      const rtkElement = result.elements.find((e) => e.name === "realtime_kit");
      expect(rtkElement?.worker_url).toBe(`https://${defaultConfig.agentUrl}`);
    });

    it("should return realtimeKitComponent reference when no auth token", () => {
      const rtk = new RealtimeKitTransport({ meetingId: "test" });
      const pipeline = [rtk];

      const result = buildPipelineSchema({ ...defaultConfig, pipeline });

      expect(result.realtimeKitComponent).toBe(rtk);
    });

    it("should not return realtimeKitComponent reference when auth token is set", () => {
      const rtk = new RealtimeKitTransport({
        meetingId: "test",
        authToken: "existing-token"
      });
      const pipeline = [rtk];

      const result = buildPipelineSchema({ ...defaultConfig, pipeline });

      expect(result.realtimeKitComponent).toBeUndefined();
    });
  });

  describe("agent element handling", () => {
    it("should configure agent as websocket element", () => {
      const agent = new MockAgent();
      const pipeline = [agent];

      const result = buildPipelineSchema({ ...defaultConfig, pipeline });

      const agentElement = result.elements.find((e) => e.name === "agent");
      expect(agentElement?.type).toBe("websocket");
      expect(agentElement?.send_events).toBe(true);
      expect(agentElement?.url).toBe(`wss://${defaultConfig.agentUrl}/ws`);
    });
  });

  describe("element deduplication", () => {
    it("should deduplicate elements by name", () => {
      const rtk = new RealtimeKitTransport({ meetingId: "test" });
      // Create a pipeline where rtk appears conceptually twice
      // (e.g., at start and end for audio in/out)
      const stt = createMockSTT();
      const agent = new MockAgent();
      const tts = createMockTTS();

      const pipeline = [rtk, stt, agent, tts, rtk];

      const result = buildPipelineSchema({ ...defaultConfig, pipeline });

      const rtkElements = result.elements.filter(
        (e) => e.name === "realtime_kit"
      );
      expect(rtkElements.length).toBe(1);
    });
  });

  describe("audio input layer (STT -> Agent pattern)", () => {
    it("should add audio input layer when STT is immediately followed by Agent", () => {
      const rtk = new RealtimeKitTransport({ meetingId: "test" });
      const stt = createMockSTT();
      const agent = new MockAgent();

      const pipeline = [rtk, stt, agent];

      const result = buildPipelineSchema({ ...defaultConfig, pipeline });

      const audioInputLayer = result.layers.find(
        (l) => l.name === "default" && l.filters?.[0]?.media_kind === "audio"
      );
      expect(audioInputLayer).toBeDefined();
      expect(audioInputLayer?.elements).toEqual([
        "realtime_kit",
        "mock_stt",
        "agent"
      ]);
      expect(audioInputLayer?.filters).toEqual([{ media_kind: "audio" }]);
    });

    it("should NOT add audio input layer when STT is not immediately followed by Agent", () => {
      const rtk = new RealtimeKitTransport({ meetingId: "test" });
      const stt = createMockSTT();
      const middleComponent = createMockComponent(
        "middle",
        [DataKind.Text],
        [DataKind.Text]
      );
      const agent = new MockAgent();

      const pipeline = [rtk, stt, middleComponent, agent];

      const result = buildPipelineSchema({ ...defaultConfig, pipeline });

      // Should have no audio layers since STT -> Agent pattern doesn't exist
      const audioLayers = result.layers.filter(
        (l) => l.filters?.[0]?.media_kind === "audio"
      );
      expect(audioLayers.length).toBe(0);
    });

    it("should NOT add audio input layer when no STT component exists", () => {
      const rtk = new RealtimeKitTransport({ meetingId: "test" });
      // Use media agent that accepts Audio input (like RTK output)
      const agent = new MockMediaAgent([DataKind.Audio], [DataKind.Audio]);

      const pipeline = [rtk, agent];

      const result = buildPipelineSchema({
        ...defaultConfig,
        parentClassName: "MockMediaAgent",
        pipeline
      });

      // No audio layers since no STT -> Agent pattern
      const audioLayers = result.layers.filter(
        (l) => l.filters?.[0]?.media_kind === "audio"
      );
      expect(audioLayers.length).toBe(0);
    });

    it("should NOT add audio input layer when consumeAudio is false", () => {
      const rtk = new RealtimeKitTransport({
        meetingId: "test",
        media: { consumeAudio: false }
      });
      const stt = createMockSTT();
      const agent = new MockAgent();

      const pipeline = [rtk, stt, agent];

      const result = buildPipelineSchema({ ...defaultConfig, pipeline });

      const audioLayers = result.layers.filter(
        (l) => l.filters?.[0]?.media_kind === "audio"
      );
      expect(audioLayers.length).toBe(0);
    });
  });

  describe("audio output layer (Agent -> TTS pattern)", () => {
    it("should add audio output layer when Agent is immediately followed by TTS", () => {
      const rtk = new RealtimeKitTransport({ meetingId: "test" });
      // Agent that accepts Audio (from RTK) and outputs Text (for TTS)
      const agent = new MockMediaAgent([DataKind.Audio], [DataKind.Text]);
      const tts = createMockTTS();

      const pipeline = [rtk, agent, tts, rtk];

      const result = buildPipelineSchema({
        ...defaultConfig,
        parentClassName: "MockMediaAgent",
        pipeline
      });

      // Find audio output layer
      const audioLayers = result.layers.filter(
        (l) => l.filters?.[0]?.media_kind === "audio"
      );
      // Should have 1 audio layer (output only, since no STT -> Agent pattern)
      expect(audioLayers.length).toBe(1);
      expect(audioLayers[0].elements).toEqual([
        "agent",
        "mock_tts",
        "realtime_kit"
      ]);
    });

    it("should NOT add audio output layer when Agent is not immediately followed by TTS", () => {
      const rtk = new RealtimeKitTransport({ meetingId: "test" });
      // Agent that accepts Audio (from RTK) and outputs Text
      const agent = new MockMediaAgent([DataKind.Audio], [DataKind.Text]);
      const middleComponent = createMockComponent(
        "middle",
        [DataKind.Text],
        [DataKind.Text]
      );
      const tts = createMockTTS();

      const pipeline = [rtk, agent, middleComponent, tts, rtk];

      const result = buildPipelineSchema({
        ...defaultConfig,
        parentClassName: "MockMediaAgent",
        pipeline
      });

      const audioLayers = result.layers.filter(
        (l) => l.filters?.[0]?.media_kind === "audio"
      );
      expect(audioLayers.length).toBe(0);
    });

    it("should NOT add audio output layer when no TTS component exists", () => {
      const rtk = new RealtimeKitTransport({ meetingId: "test" });
      // Agent that accepts and outputs Audio (no TTS)
      const agent = new MockMediaAgent([DataKind.Audio], [DataKind.Audio]);

      const pipeline = [rtk, agent, rtk];

      const result = buildPipelineSchema({
        ...defaultConfig,
        parentClassName: "MockMediaAgent",
        pipeline
      });

      const audioLayers = result.layers.filter(
        (l) => l.filters?.[0]?.media_kind === "audio"
      );
      expect(audioLayers.length).toBe(0);
    });

    it("should NOT add audio output layer when consumeAudio is false", () => {
      const rtk = new RealtimeKitTransport({
        meetingId: "test",
        media: { consumeAudio: false }
      });
      // Agent that accepts Audio and outputs Text
      const agent = new MockMediaAgent([DataKind.Audio], [DataKind.Text]);
      const tts = createMockTTS();

      const pipeline = [rtk, agent, tts, rtk];

      const result = buildPipelineSchema({
        ...defaultConfig,
        parentClassName: "MockMediaAgent",
        pipeline
      });

      const audioLayers = result.layers.filter(
        (l) => l.filters?.[0]?.media_kind === "audio"
      );
      expect(audioLayers.length).toBe(0);
    });
  });

  describe("full audio pipeline (STT -> Agent -> TTS)", () => {
    it("should add both audio input and output layers", () => {
      const rtk = new RealtimeKitTransport({ meetingId: "test" });
      const stt = createMockSTT();
      const agent = new MockAgent();
      const tts = createMockTTS();

      const pipeline = [rtk, stt, agent, tts, rtk];

      const result = buildPipelineSchema({ ...defaultConfig, pipeline });

      const audioLayers = result.layers.filter(
        (l) => l.filters?.[0]?.media_kind === "audio"
      );
      expect(audioLayers.length).toBe(2);

      // First layer: audio input (rtk -> stt -> agent)
      expect(audioLayers[0].name).toBe("default");
      expect(audioLayers[0].elements).toEqual([
        "realtime_kit",
        "mock_stt",
        "agent"
      ]);

      // Second layer: audio output (agent -> tts -> rtk)
      expect(audioLayers[1].name).toBe("default-2");
      expect(audioLayers[1].elements).toEqual([
        "agent",
        "mock_tts",
        "realtime_kit"
      ]);
    });
  });

  describe("video layer", () => {
    it("should add video layer when consumeVideo is true", () => {
      const rtk = new RealtimeKitTransport({
        meetingId: "test",
        media: { consumeVideo: true }
      });
      // Agent that accepts Audio (RTK output type)
      const agent = new MockMediaAgent([DataKind.Audio], [DataKind.Audio]);

      const pipeline = [rtk, agent];

      const result = buildPipelineSchema({
        ...defaultConfig,
        parentClassName: "MockMediaAgent",
        pipeline
      });

      const videoLayers = result.layers.filter(
        (l) => l.filters?.[0]?.media_kind === "video"
      );
      expect(videoLayers.length).toBe(1);
      expect(videoLayers[0].elements).toEqual(["realtime_kit", "agent"]);
      expect(videoLayers[0].filters).toEqual([{ media_kind: "video" }]);
    });

    it("should NOT add video layer when consumeVideo is false (default)", () => {
      const rtk = new RealtimeKitTransport({ meetingId: "test" });
      // Agent that accepts Audio (RTK output type)
      const agent = new MockMediaAgent([DataKind.Audio], [DataKind.Audio]);

      const pipeline = [rtk, agent];

      const result = buildPipelineSchema({
        ...defaultConfig,
        parentClassName: "MockMediaAgent",
        pipeline
      });

      const videoLayers = result.layers.filter(
        (l) => l.filters?.[0]?.media_kind === "video"
      );
      expect(videoLayers.length).toBe(0);
    });
  });

  describe("screenshare layer", () => {
    it("should add screenshare layer when consumeScreenshare is true", () => {
      const rtk = new RealtimeKitTransport({
        meetingId: "test",
        media: { consumeScreenshare: true }
      });
      // Agent that accepts Audio (RTK output type)
      const agent = new MockMediaAgent([DataKind.Audio], [DataKind.Audio]);

      const pipeline = [rtk, agent];

      const result = buildPipelineSchema({
        ...defaultConfig,
        parentClassName: "MockMediaAgent",
        pipeline
      });

      const videoLayers = result.layers.filter(
        (l) => l.filters?.[0]?.media_kind === "video"
      );
      expect(videoLayers.length).toBe(1);
      expect(videoLayers[0].elements).toEqual(["realtime_kit", "agent"]);
    });

    it("should NOT add screenshare layer when consumeScreenshare is false (default)", () => {
      const rtk = new RealtimeKitTransport({ meetingId: "test" });
      // Agent that accepts Audio (RTK output type)
      const agent = new MockMediaAgent([DataKind.Audio], [DataKind.Audio]);

      const pipeline = [rtk, agent];

      const result = buildPipelineSchema({
        ...defaultConfig,
        parentClassName: "MockMediaAgent",
        pipeline
      });

      const videoLayers = result.layers.filter(
        (l) => l.filters?.[0]?.media_kind === "video"
      );
      expect(videoLayers.length).toBe(0);
    });
  });

  describe("combined media configurations", () => {
    it("should add all layers when all media types are enabled with full audio pipeline", () => {
      const rtk = new RealtimeKitTransport({
        meetingId: "test",
        media: {
          consumeAudio: true,
          consumeVideo: true,
          consumeScreenshare: true
        }
      });
      const stt = createMockSTT();
      const agent = new MockAgent();
      const tts = createMockTTS();

      const pipeline = [rtk, stt, agent, tts, rtk];

      const result = buildPipelineSchema({ ...defaultConfig, pipeline });

      // Should have 4 layers: audio input, audio output, video, screenshare
      expect(result.layers.length).toBe(4);

      // Audio layers
      const audioLayers = result.layers.filter(
        (l) => l.filters?.[0]?.media_kind === "audio"
      );
      expect(audioLayers.length).toBe(2);

      // Video layers (video + screenshare)
      const videoLayers = result.layers.filter(
        (l) => l.filters?.[0]?.media_kind === "video"
      );
      expect(videoLayers.length).toBe(2);
    });

    it("should only add video/screenshare layers when no audio pipeline exists", () => {
      const rtk = new RealtimeKitTransport({
        meetingId: "test",
        media: {
          consumeAudio: true,
          consumeVideo: true,
          consumeScreenshare: true
        }
      });
      // Agent that accepts Audio (RTK output type)
      const agent = new MockMediaAgent([DataKind.Audio], [DataKind.Audio]);

      // No STT or TTS, just rtk -> agent
      const pipeline = [rtk, agent];

      const result = buildPipelineSchema({
        ...defaultConfig,
        parentClassName: "MockMediaAgent",
        pipeline
      });

      // Should have 2 layers: video and screenshare (no audio layers since no STT/TTS pattern)
      expect(result.layers.length).toBe(2);

      const audioLayers = result.layers.filter(
        (l) => l.filters?.[0]?.media_kind === "audio"
      );
      expect(audioLayers.length).toBe(0);

      const videoLayers = result.layers.filter(
        (l) => l.filters?.[0]?.media_kind === "video"
      );
      expect(videoLayers.length).toBe(2);
    });

    it("should handle video-only pipeline (no audio)", () => {
      const rtk = new RealtimeKitTransport({
        meetingId: "test",
        media: {
          consumeAudio: false,
          consumeVideo: true
        }
      });
      const stt = createMockSTT();
      const agent = new MockAgent();
      const tts = createMockTTS();

      const pipeline = [rtk, stt, agent, tts, rtk];

      const result = buildPipelineSchema({ ...defaultConfig, pipeline });

      // Should have 1 layer: video only (audio disabled)
      expect(result.layers.length).toBe(1);

      const audioLayers = result.layers.filter(
        (l) => l.filters?.[0]?.media_kind === "audio"
      );
      expect(audioLayers.length).toBe(0);

      const videoLayers = result.layers.filter(
        (l) => l.filters?.[0]?.media_kind === "video"
      );
      expect(videoLayers.length).toBe(1);
    });
  });

  describe("layer naming", () => {
    it("should name first layer 'default' and subsequent layers 'default-N'", () => {
      const rtk = new RealtimeKitTransport({
        meetingId: "test",
        media: {
          consumeAudio: true,
          consumeVideo: true,
          consumeScreenshare: true
        }
      });
      const stt = createMockSTT();
      const agent = new MockAgent();
      const tts = createMockTTS();

      const pipeline = [rtk, stt, agent, tts, rtk];

      const result = buildPipelineSchema({ ...defaultConfig, pipeline });

      expect(result.layers[0].name).toBe("default");
      expect(result.layers[1].name).toBe("default-2");
      expect(result.layers[2].name).toBe("default-3");
      expect(result.layers[3].name).toBe("default-4");
    });

    it("should have sequential layer IDs starting from 1", () => {
      const rtk = new RealtimeKitTransport({
        meetingId: "test",
        media: {
          consumeAudio: true,
          consumeVideo: true
        }
      });
      const stt = createMockSTT();
      const agent = new MockAgent();
      const tts = createMockTTS();

      const pipeline = [rtk, stt, agent, tts, rtk];

      const result = buildPipelineSchema({ ...defaultConfig, pipeline });

      expect(result.layers[0].id).toBe(1);
      expect(result.layers[1].id).toBe(2);
      expect(result.layers[2].id).toBe(3);
    });
  });

  describe("edge cases", () => {
    it("should handle empty pipeline", () => {
      const result = buildPipelineSchema({ ...defaultConfig, pipeline: [] });

      expect(result.elements).toEqual([]);
      expect(result.layers).toEqual([]);
      expect(result.realtimeKitComponent).toBeUndefined();
    });

    it("should handle pipeline with only agent", () => {
      const agent = new MockAgent();
      const pipeline = [agent];

      const result = buildPipelineSchema({ ...defaultConfig, pipeline });

      expect(result.elements.length).toBe(1);
      expect(result.layers).toEqual([]);
    });

    it("should name first layer default even when its not audio input", () => {
      const rtk = new RealtimeKitTransport({
        meetingId: "test",
        media: {
          consumeAudio: false,
          consumeVideo: true
        }
      });
      // Agent that accepts Audio (RTK output type)
      const agent = new MockMediaAgent([DataKind.Audio], [DataKind.Audio]);

      const pipeline = [rtk, agent];

      const result = buildPipelineSchema({
        ...defaultConfig,
        parentClassName: "MockMediaAgent",
        pipeline
      });

      // Video layer should be named "default" since its the first layer
      expect(result.layers[0].name).toBe("default");
    });
  });
});
