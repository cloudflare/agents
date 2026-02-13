import {
  DataKind,
  RealtimeKitTransport,
  type RealtimeKitLayerFilter,
  type RealtimePipelineComponent
} from "./components";

/**
 * Configuration for building pipeline schema
 */
export type PipelineSchemaConfig = {
  /** The pipeline components to convert to schema */
  pipeline: RealtimePipelineComponent[];
  /** The agent URL for websocket connections */
  agentUrl: string;
  /** The name of the parent agent class (for identifying the agent component) */
  parentClassName: string;
  /** Optional meeting ID for RealtimeKit transport */
  meetingId?: string | null;
};

/**
 * Layer configuration with optional filters
 */
export type PipelineLayer = {
  id: number;
  name: string;
  elements: string[];
  filters?: Array<{
    media_kind: "audio" | "video";
  }>;
};

/**
 * Result of building pipeline schema
 */
export type PipelineSchemaResult = {
  /** The layers configuration for the pipeline */
  layers: PipelineLayer[];
  /** The elements configuration for the pipeline */
  elements: { name: string; [K: string]: unknown }[];
  /** Reference to RealtimeKit transport component if present and needs auth token */
  realtimeKitComponent?: RealtimeKitTransport;
};

/**
 * Validates pipeline component chain and builds schema configuration.
 * This is a pure function that can be tested independently.
 *
 * @param config - Configuration for building the pipeline schema
 * @returns The layers and elements configuration for the realtime API
 * @throws Error if component chain has mismatched input/output kinds
 * @throws Error if RealtimeKit transport is missing meeting ID
 */
export function buildPipelineSchema(
  config: PipelineSchemaConfig
): PipelineSchemaResult {
  const { pipeline, agentUrl, parentClassName, meetingId } = config;

  // Validate component chain - check that adjacent components share at least one common DataKind
  let lastComponent: RealtimePipelineComponent | undefined;
  for (const component of pipeline) {
    if (lastComponent) {
      const outputKinds = lastComponent.output_kind();
      const inputKinds = component.input_kind();
      const hasOverlap = outputKinds.some((kind) => inputKinds.includes(kind));
      if (!hasOverlap) {
        throw new Error(
          `Cannot link component of output kind ${outputKinds.join(",")} with input kind ${inputKinds.join(",")}`
        );
      }
    }
    lastComponent = component;
  }

  // Build elements and find key components
  let elements: { name: string; [K: string]: unknown }[] = [];
  let realtimeKitComponent: RealtimeKitTransport | undefined;
  let agentElementName = "agent";
  let rtkElementName = "realtime_kit";

  // Audio filter for RTK
  const audioFilter: RealtimeKitLayerFilter = {
    media_kind: "audio",
    stream_kind: "microphone",
    preset_name: "*"
  };

  // Video filter for RTK
  const videoFilter: RealtimeKitLayerFilter = {
    media_kind: "video",
    stream_kind: "webcam",
    preset_name: "*"
  };

  // Screenshare filter for RTK
  const screenshareFilter: RealtimeKitLayerFilter = {
    media_kind: "video",
    stream_kind: "screen_share",
    preset_name: "*"
  };

  for (const component of pipeline) {
    const schema = component.schema();

    // Handle Agent as websocket element
    if (component.constructor.name === parentClassName) {
      schema.type = "websocket";
      schema.send_events = true;
      schema.url = `wss://${agentUrl}/ws`;
      agentElementName = schema.name;
    }

    // Handle RealtimeKit transport
    if (component instanceof RealtimeKitTransport) {
      schema.worker_url = `https://${agentUrl}`;
      rtkElementName = schema.name;
      if (!component.authToken) {
        realtimeKitComponent = component;
      }
      if (meetingId) {
        component.meetingId = meetingId;
        schema.meeting_id = meetingId;
      }
      if (!component.meetingId) {
        throw new Error("Meeting ID not set for RealtimeKit transport");
      }

      // Add filters to the rtk element based on media config
      const rtkFilters: RealtimeKitLayerFilter[] = [];
      if (component.media.consumeAudio) {
        rtkFilters.push(audioFilter);
      }
      if (component.media.consumeVideo) {
        rtkFilters.push(videoFilter);
      }
      if (component.media.consumeScreenshare) {
        rtkFilters.push(screenshareFilter);
      }
      schema.filters = rtkFilters;
    }

    elements.push(schema);
  }

  // Deduplicate elements by name
  elements = elements.filter(
    (v, idx, arr) => idx === arr.findIndex((v1) => v1.name === v.name)
  );

  // Build layers based on media config and pipeline structure
  const layers: PipelineLayer[] = [];
  let layerId = 1;

  // Get media config from RealtimeKit component
  const mediaConfig = realtimeKitComponent?.media ?? { consumeAudio: true };

  // Helper to check if a component is STT (Audio -> Text)
  const isSTT = (component: RealtimePipelineComponent) =>
    component.input_kind().includes(DataKind.Audio) &&
    component.output_kind().includes(DataKind.Text);

  // Helper to check if a component is TTS (Text -> Audio)
  const isTTS = (component: RealtimePipelineComponent) =>
    component.input_kind().includes(DataKind.Text) &&
    component.output_kind().includes(DataKind.Audio);

  // Helper to check if a component is the Agent
  const isAgent = (component: RealtimePipelineComponent) =>
    component.constructor.name === parentClassName;

  // Detect STT -> Agent pattern (audio input path)
  let hasSttToAgent = false;
  let sttIndex = -1;
  let agentIndex = -1;

  for (let i = 0; i < pipeline.length; i++) {
    if (isSTT(pipeline[i])) {
      sttIndex = i;
    }
    if (isAgent(pipeline[i])) {
      agentIndex = i;
      break;
    }
  }

  if (sttIndex !== -1 && agentIndex !== -1 && sttIndex < agentIndex) {
    // Check if STT is immediately followed by Agent
    hasSttToAgent = sttIndex + 1 === agentIndex;
  }

  // Detect Agent -> TTS pattern (audio output path)
  let hasAgentToTts = false;
  let ttsIndex = -1;

  for (let i = 0; i < pipeline.length; i++) {
    if (isAgent(pipeline[i])) {
      agentIndex = i;
    }
    if (isTTS(pipeline[i])) {
      ttsIndex = i;
      break;
    }
  }

  if (agentIndex !== -1 && ttsIndex !== -1 && agentIndex < ttsIndex) {
    // Check if Agent is immediately followed by TTS
    hasAgentToTts = agentIndex + 1 === ttsIndex;
  }

  // Layer 1: Audio input path (only if STT -> Agent pattern exists)
  if (hasSttToAgent && mediaConfig.consumeAudio) {
    // Build element names from start to agent (inclusive)
    const audioInputElements: string[] = [];
    for (const component of pipeline) {
      audioInputElements.push(component.schema().name);
      if (isAgent(component)) {
        break;
      }
    }

    layers.push({
      id: layerId++,
      name: layers.length === 0 ? "default" : `default-${layerId - 1}`,
      elements: audioInputElements,
      filters: [{ media_kind: "audio" }]
    });
  }

  // Layer 2: Audio output path (only if Agent -> TTS pattern exists)
  if (hasAgentToTts && mediaConfig.consumeAudio) {
    // Build element names from agent onwards
    const audioOutputElements: string[] = [];
    let foundAgent = false;
    for (const component of pipeline) {
      if (isAgent(component)) {
        foundAgent = true;
      }
      if (foundAgent) {
        audioOutputElements.push(component.schema().name);
      }
    }

    layers.push({
      id: layerId++,
      name: layers.length === 0 ? "default" : `default-${layerId - 1}`,
      elements: audioOutputElements,
      filters: [{ media_kind: "audio" }]
    });
  }

  // Video layer (only if consumeVideo is enabled)
  if (mediaConfig.consumeVideo) {
    layers.push({
      id: layerId++,
      name: layers.length === 0 ? "default" : `default-${layerId - 1}`,
      elements: [rtkElementName, agentElementName],
      filters: [{ media_kind: "video" }]
    });
  }

  // Screenshare layer (only if consumeScreenshare is enabled)
  if (mediaConfig.consumeScreenshare) {
    layers.push({
      id: layerId++,
      name: layers.length === 0 ? "default" : `default-${layerId - 1}`,
      elements: [rtkElementName, agentElementName],
      filters: [{ media_kind: "video" }]
    });
  }

  console.log("layers", JSON.stringify(layers, null, 2));

  return { layers, elements, realtimeKitComponent };
}
