import {
  DataKind,
  RealtimeKitTransport,
  WebSocketTransport,
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
  /** The constructor name of the parent RealtimeAgent class, used to identify the agent component in the pipeline */
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
    media_kind: "audio" | "video" | "text";
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
  let rtkMediaConfig: RealtimeKitTransport["media"] | undefined;
  let agentElementName = "agent";
  let hasWebSocketComponent = false;
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

    // Handle websocket components (WebSocketTransport or Agent passed as `this`).
    // The schema already has type/send_events set by the component itself.
    // We only need to set the URL (not known at construction time) and track the element name.
    if (
      component instanceof WebSocketTransport ||
      component.constructor.name === parentClassName
    ) {
      if (!schema.url) {
        schema.url = `wss://${agentUrl}/ws`;
      }
      agentElementName = schema.name;
      hasWebSocketComponent = true;
    }

    // Handle RealtimeKit transport
    if (component instanceof RealtimeKitTransport) {
      schema.worker_url = `https://${agentUrl}`;
      rtkElementName = schema.name;
      rtkMediaConfig = rtkMediaConfig ?? component.media;
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

  // Get media config from the first RTK component found (regardless of auth token)
  const mediaConfig = rtkMediaConfig ?? { consumeAudio: true };

  // Helper to infer media filters from a component's kind list.
  // Returns a filter for each applicable kind rather than picking just one.
  const kindToMediaKind: Record<string, "audio" | "video" | "text"> = {
    [DataKind.Audio]: "audio",
    [DataKind.Video]: "video",
    [DataKind.Text]: "text"
  };

  const inferFilter = (
    kinds: DataKind[]
  ): Array<{ media_kind: "audio" | "video" | "text" }> => {
    return kinds
      .map((k) => kindToMediaKind[k])
      .filter(Boolean)
      .map((mk) => ({ media_kind: mk }));
  };

  // Add a layer or merge filters into an existing layer with the same elements.
  const addLayer = (
    elementNames: string[],
    filters: Array<{ media_kind: "audio" | "video" | "text" }>
  ) => {
    const key = elementNames.join(",");
    const existing = layers.find((l) => l.elements.join(",") === key);
    if (existing) {
      // Merge filters into the existing layer
      existing.filters = [...(existing.filters ?? []), ...filters];
    } else {
      layers.push({
        id: layerId++,
        name: layers.length === 0 ? "default" : `default-${layerId - 1}`,
        elements: elementNames,
        ...(filters.length > 0 ? { filters } : {})
      });
    }
  };

  // Find all split points: agent (this) or WebSocketTransport instances
  // that have elements on both sides. Each split point creates a layer boundary.
  const isSplitCandidate = (c: RealtimePipelineComponent) =>
    c.constructor.name === parentClassName || c instanceof WebSocketTransport;

  const splitIndices: number[] = [];
  for (let i = 0; i < pipeline.length; i++) {
    if (isSplitCandidate(pipeline[i]) && i > 0 && i < pipeline.length - 1) {
      splitIndices.push(i);
    }
  }

  if (splitIndices.length > 0) {
    // Split mode: create layers between consecutive split points.
    // Each layer runs from one boundary to the next, with split points shared
    // between adjacent layers.
    //
    // For split points [s1, s2] in pipeline [A, B, s1, C, s2, D]:
    //   Layer 1: [A, B, s1]       (start → first split)
    //   Layer 2: [s1, C, s2]      (first split → second split)
    //   Layer 3: [s2, D]          (last split → end)

    const boundaries = [0, ...splitIndices, pipeline.length];

    for (let b = 0; b < boundaries.length - 1; b++) {
      const start = b === 0 ? boundaries[b] : boundaries[b]; // split point included
      const end = boundaries[b + 1]; // up to next boundary (inclusive for split points)

      const slice =
        b === 0
          ? pipeline.slice(start, end + 1) // first layer: start to first split (inclusive)
          : b === boundaries.length - 2
            ? pipeline.slice(start, end) // last layer: last split to end
            : pipeline.slice(start, end + 1); // middle: split to next split (inclusive)

      const layerElements = slice.map((c) => c.schema().name);

      // Infer filter from the 2nd element's input_kind in this layer segment
      const secondInLayer = slice.length > 1 ? slice[1] : undefined;
      const filters = secondInLayer
        ? inferFilter(secondInLayer.input_kind())
        : [];

      addLayer(layerElements, filters);
    }
  } else if (pipeline.length > 0) {
    // No-split mode: no split point with elements on both sides.
    // Single layer with all elements; filter inferred from 2nd component.
    const allElementNames = pipeline.map((c) => c.schema().name);
    const secondComponent = pipeline.length > 1 ? pipeline[1] : undefined;
    const filters = secondComponent
      ? inferFilter(secondComponent.input_kind())
      : [];

    addLayer(allElementNames, filters);
  }

  // Video layer (only if consumeVideo is enabled and a websocket component exists)
  if (hasWebSocketComponent && mediaConfig.consumeVideo) {
    addLayer([rtkElementName, agentElementName], [{ media_kind: "video" }]);
  }

  return { layers, elements, realtimeKitComponent };
}
