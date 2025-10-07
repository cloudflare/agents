import RealtimeKitClient from "@cloudflare/realtimekit";
import {
  Agent,
  type AgentContext,
  type Connection,
  type ConnectionContext,
  type WSMessage
} from "../";
import {
  isRealtimeRequest,
  isRealtimeWebsocketMessage,
  processNDJSONStream,
  REALTIME_WS_TAG,
  type RealtimeWebsocketMessage,
  type RealtimeState
} from "./utils";
import { RealtimeAPI } from "./api";
import {
  RealtimeKitTransport,
  type RealtimePipelineComponent
} from "./components";
import { camelCaseToKebabCase } from "../client";
import { randomUUID } from "node:crypto";

export type SpeakResponse = {
  text: string | ReadableStream<Uint8Array>;
  canInterrupt?: boolean;
};

export type TranscriptEntry = {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
};

export type RealtimeSnapshot = {
  pipelineState: RealtimeState;
  flowId?: string;
};

export class RealtimeAgent<Env = unknown, State = unknown> extends Agent<
  Env,
  State
> {
  public pipelineState: RealtimeState = "idle";
  private api: RealtimeAPI;
  private pipeline: RealtimePipelineComponent[] = [];
  private agentUrl?: string;
  private flowId?: string;
  private token?: string;
  private agentName: string;
  /** Array of transcript entries for the current conversation */
  public transcriptHistory: TranscriptEntry[];

  #meeting?: RealtimeKitClient;

  constructor(ctx: AgentContext, env: Env, ai: Ai, gatewayId?: string) {
    super(ctx, env);
    this.api = new RealtimeAPI(ai, gatewayId);
    // Get the agent name from the class constructor
    this.agentName = camelCaseToKebabCase(
      Object.getPrototypeOf(this).constructor.name
    );

    // Initialize transcript history table
    this.sql`create table if not exists cf_realtime_agent_transcripts (
      id text primary key,
      role text not null,
      text text not null,
      timestamp integer not null,
      created_at datetime default current_timestamp
    )`;

    // Load transcript history from database
    this.transcriptHistory = this._loadTranscriptsFromDb();

    this.keepAlive();
  }

  setPipeline(pipeline: RealtimePipelineComponent[]) {
    this.pipeline = pipeline;
  }

  /**
   * Load transcript history from the database
   */
  private _loadTranscriptsFromDb(): TranscriptEntry[] {
    const rows =
      this
        .sql`select * from cf_realtime_agent_transcripts order by timestamp` ||
      [];
    return rows
      .map((row) => {
        try {
          return {
            id: row.id as string,
            role: row.role as "user" | "assistant",
            text: row.text as string,
            timestamp: row.timestamp as number
          };
        } catch (error) {
          console.error(`Failed to parse transcript ${row.id}:`, error);
          return null;
        }
      })
      .filter((entry): entry is TranscriptEntry => entry !== null);
  }

  /**
   * Persist transcript entries to the database
   * @param entries Transcript entries to save
   */
  async persistTranscripts(entries: TranscriptEntry[]) {
    for (const entry of entries) {
      this.sql`
        insert into cf_realtime_agent_transcripts (id, role, text, timestamp)
        values (${entry.id}, ${entry.role}, ${entry.text}, ${entry.timestamp})
        on conflict(id) do update set 
          text = excluded.text,
          timestamp = excluded.timestamp
      `;
    }

    // Refresh in-memory transcript history
    this.transcriptHistory = this._loadTranscriptsFromDb();
  }

  /**
   * Add a transcript entry to the history
   * @param role The role (user or assistant)
   * @param text The transcript text
   */
  async addTranscript(role: "user" | "assistant", text: string) {
    const entry: TranscriptEntry = {
      id: randomUUID(),
      role,
      text,
      timestamp: Date.now()
    };
    await this.persistTranscripts([entry]);
  }

  /**
   * Clear all transcript history
   */
  async clearTranscriptHistory() {
    this.sql`delete from cf_realtime_agent_transcripts`;
    this.transcriptHistory = [];
  }

  /**
   * Get transcript history formatted as a conversation string
   * @param maxEntries Maximum number of recent entries to include (default: all)
   */
  getFormattedHistory(maxEntries?: number): string {
    const entries = maxEntries
      ? this.transcriptHistory.slice(-maxEntries)
      : this.transcriptHistory;

    return entries
      .map(
        (entry) =>
          `${entry.role === "user" ? "User" : "Assistant"}: ${entry.text}`
      )
      .join("\n");
  }

  /**
   * Possibly undefined if no rtk element is configured.
   */
  get meeting(): RealtimeKitClient | undefined {
    return this.#meeting;
  }

  async keepAlive() {
    this.schedule(10, "keepAlive");
  }
  /**
   * Called when a RealtimeKit meeting is initialized
   * Override this to handle meeting-specific setup
   */
  public onRealtimeMeeting?(meeting: RealtimeKitClient): void | Promise<void>;

  /**
   * Called when the Agent receives a new transcript from the Realtime pipeline
   * Override this method to handle incoming transcripts
   * @param text The text of the transcript
   * @returns Response containing text to speak and whether it can be interrupted
   */
  async onRealtimeTranscript(text: string): Promise<SpeakResponse | undefined> {
    throw new Error(
      "received a transcript, override onRealtimeTranscript and return text that you want agent to speak."
    );
  }

  /**
   * Called when the Agent receives a video frame from the Realtime pipeline
   * Override this method to handle incoming video frames
   * @param frame The video frame data
   * @returns Response containing text to speak and whether it can be interrupted
   */
  async onRealtimeVideoFrame(
    frame: string
  ): Promise<SpeakResponse | undefined> {
    throw new Error(
      "received a video frame, override onRealtimeVideoFrame and return text that you want agent to speak."
    );
  }

  /**
   * Initialize the realtime pipeline
   * @param agentURL The URL of the agent
   */
  async init(agentURL: string) {
    // Validate component chain
    let last_component: RealtimePipelineComponent | undefined;
    for (const component of this.pipeline) {
      if (
        last_component &&
        last_component.output_kind() !== component.input_kind()
      ) {
        throw new Error(
          `Cannot link component of output kind ${last_component.output_kind()} with input kind ${component.input_kind()}`
        );
      }
      last_component = component;
    }

    // Build layers and elements
    const layers: { id: number; name: string; elements: string[] }[] = [
      { id: 1, name: "default", elements: [] }
    ];
    let elements: { name: string; [K: string]: unknown }[] = [];
    let realtimeKitComponent: RealtimeKitTransport | undefined = undefined;

    const parentName = Object.getPrototypeOf(this).constructor.name;

    for (const component of this.pipeline) {
      const schema = component.schema();

      // Handle Agent as websocket element
      if (component.constructor.name === parentName) {
        schema.type = "websocket";
        schema.send_events = true;
        schema.url = `wss://${agentURL}/ws`;

        layers[layers.length - 1].elements.push(schema.name);
        layers.push({
          id: layers.length + 1,
          name: `default-${layers.length + 1}`,
          elements: []
        });
      }

      // Handle RealtimeKit transport
      if (component instanceof RealtimeKitTransport) {
        schema.worker_url = `https://${agentURL}`;
        if (!component.authToken) {
          realtimeKitComponent = component;
        }
      }

      elements.push(schema);
      layers[layers.length - 1].elements.push(schema.name);
    }

    // Deduplicate elements by name
    elements = elements.filter(
      (v, idx, arr) => idx === arr.findIndex((v1) => v1.name === v.name)
    );

    console.log(
      `[Pipeline configuration]: layers: ${JSON.stringify(layers)}, elements: ${JSON.stringify(elements)}`
    );

    // Create pipeline
    try {
      const {
        id,
        token,
        elements: newElements
      } = await this.api.createPipeline({
        elements,
        layers
      });
      console.log(`[Pipeline provisioned] flowId: ${id}, token: ${token}`);

      this.flowId = id;
      this.token = token;

      if (realtimeKitComponent) {
        const realtimeKitElement = newElements.filter((e) => {
          return e.name === realtimeKitComponent.name;
        });
        if (!realtimeKitElement) {
          throw new Error("RealtimeKit element not found in pipeline");
        }
        realtimeKitComponent.authToken = (
          realtimeKitElement[0] as { auth_token: string }
        ).auth_token;
      }
    } catch (e) {
      console.log(e);
    }
  }

  /**
   * Start the realtime pipeline
   * This will initialize the pipeline and start processing
   */
  async startRealtimePipeline() {
    if (this.pipelineState !== "idle") {
      throw new Error("Pipeline is already running");
    }

    this.pipelineState = "initializing";

    if (!this.agentUrl) {
      throw new Error("Agent URL not set. Call buildAgentUrl first.");
    }

    await this.init(this.agentUrl);

    if (!this.token) {
      throw new Error("Pipeline not initialized - missing auth token");
    }

    // Initialize RealtimeKit transport (meeting join) only when starting
    const meetingTransport = this.pipeline.find(
      (c) => c instanceof RealtimeKitTransport
    ) as RealtimeKitTransport | undefined;

    await this.api.startPipeline(this.token);

    if (meetingTransport) {
      await meetingTransport.init(this.token);
      this.#meeting = meetingTransport.meeting;

      if (this.onRealtimeMeeting) {
        // Call the onRealtimeMeeting callback
        await this.onRealtimeMeeting(meetingTransport.meeting);
      }

      meetingTransport.meeting.self.on("roomLeft", () =>
        this.stopRealtimePipeline()
      );

      await this.#meeting.join();
    }

    this.pipelineState = "running";
  }

  /**
   * Stop the realtime pipeline
   */
  async stopRealtimePipeline() {
    if (this.pipelineState !== "running") {
      throw new Error("Pipeline is not running");
    }

    this.pipelineState = "stopping";

    try {
      const meetingTransport = this.pipeline.find(
        (c) => c instanceof RealtimeKitTransport
      ) as RealtimeKitTransport | undefined;

      if (meetingTransport?.meeting.self.roomJoined) {
        meetingTransport.meeting.leave();
      }

      if (!this.token) {
        throw new Error("Missing auth token for pipeline");
      }

      await this.api.stopPipeline(this.token);
    } catch (e) {
      console.error("Failed to stop realtime pipeline", e);
    }
    this.pipelineState = "stopped";
  }

  /**
   * Dispose of the realtime pipeline
   */
  async dispose() {
    try {
      await this.stopRealtimePipeline();
    } catch (e) {
      console.error("Failed to stop realtime pipeline", e);
    }
  }

  /**
   * Build the agent URL for the realtime pipeline
   * @param url The base URL
   * @param agentId The agent ID
   */
  buildAgentUrl(url: URL, agentId: string) {
    this.agentUrl = `${url.host}/agents/${this.agentName}/${agentId}/realtime`;
  }

  override onRequest(request: Request): Response | Promise<Response> {
    if (isRealtimeRequest(request)) {
      return this.handleRealtimeRequest(request);
    }
    return super.onRequest(request);
  }

  private async handleRealtimeRequest(request: Request): Promise<Response> {
    const requestUrl = new URL(request.url);

    if (!this.agentUrl) {
      this.buildAgentUrl(requestUrl, this.name);
    }

    const path = request.url.split(
      `agents/${this.agentName}/${this.name}/realtime`
    )[1];

    switch (path) {
      case "/rtk/produce": {
        const payload = await request.json<{
          producingTransportId: string;
          producerId: string;
          kind: string;
        }>();

        const meetingTransport = this.pipeline.find(
          (c) => c instanceof RealtimeKitTransport
        ) as RealtimeKitTransport | undefined;

        if (!meetingTransport) {
          return new Response("No RealtimeKit transport configured", {
            status: 400
          });
        }

        const meeting = meetingTransport.meeting;
        if (meeting.self.roomJoined) {
          console.log("Bot joined meeting, producing...");
          await meeting.self.produce(payload);
        } else {
          console.log("Bot not joined, waiting for roomJoined event...");
          meeting.self.on("roomJoined", () => meeting.self.produce(payload));
        }

        return new Response(null, { status: 200 });
      }

      case "/start": {
        await this.startRealtimePipeline();
        return new Response("{'success':true}", { status: 200 });
      }

      case "/stop": {
        await this.stopRealtimePipeline();
        return new Response(null, { status: 200 });
      }

      case "/ping": {
        return new Response(null, { status: 200 });
      }

      case "/get-transcripts": {
        const transcripts = this._loadTranscriptsFromDb();
        return Response.json(transcripts);
      }

      case "/clear-transcripts": {
        await this.clearTranscriptHistory();
        return Response.json({ success: true });
      }

      default:
        return new Response("Not found", { status: 404 });
    }
  }

  override async onMessage(
    connection: Connection,
    message: WSMessage
  ): Promise<void> {
    if (typeof message !== "string") {
      return super.onMessage(connection, message);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch (_e) {
      // Not JSON, pass to parent
      return super.onMessage(connection, message);
    }

    // Check if this is a realtime websocket message
    if (await this.handleWebsocketMessage(parsed)) {
      return;
    }

    // Not a realtime message, pass to parent
    return super.onMessage(connection, message);
  }

  /**
   * Handle websocket messages from the realtime pipeline
   * @param message The message to handle
   * @returns true if the message was handled, false otherwise
   */
  private async handleWebsocketMessage(message: unknown): Promise<boolean> {
    if (!isRealtimeWebsocketMessage(message)) {
      return false;
    }

    if (message.type === "media") {
      switch (message.payload.content_type) {
        case "text":
          await this.#handleTextMessage(message);
          break;
        case "audio":
          await this.#handleAudioMessage(message);
          break;
        case "video":
          await this.#handleVideoMessage(message);
          break;
      }
    }

    return true;
  }

  async #handleTextMessage(message: RealtimeWebsocketMessage) {
    let contextId: string | undefined = message.payload.context_id;
    const userText = message.payload.data;

    // Store user transcript
    await this.addTranscript("user", userText);

    const response = await this.onRealtimeTranscript(userText);

    if (!response) return;

    // if a user can interrupt whatever bot is speaking
    if (!response.canInterrupt) {
      contextId = undefined;
    }

    if (typeof response.text === "string") {
      // Store assistant response
      await this.addTranscript("assistant", response.text);
      this.speak(response.text, contextId);
      return;
    }

    // Handle streaming response
    let fullResponse = "";
    for await (const chunk of processNDJSONStream(response.text.getReader())) {
      if (!chunk.response) continue;
      fullResponse += chunk.response;
      this.speak(chunk.response, contextId);
    }

    // Store the complete assistant response after streaming
    if (fullResponse) {
      await this.addTranscript("assistant", fullResponse);
    }
  }

  async #handleAudioMessage(message: RealtimeWebsocketMessage) {
    // Decode base64 audio data
    const audioData = message.payload.data;
    let frameData: Uint8Array;

    if (typeof audioData === "string") {
      // If data is base64 encoded string, decode it
      const binaryString = atob(audioData);
      frameData = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        frameData[i] = binaryString.charCodeAt(i);
      }
    } else if (
      audioData &&
      typeof audioData === "object" &&
      "buffer" in audioData
    ) {
      // If data is already a Uint8Array or similar typed array
      frameData = audioData as Uint8Array;
    } else {
      console.error("Invalid audio data format");
      return;
    }

    // For now, audio frames are not handled by default
    // Users can override onMediaFrame if needed
    console.warn("Audio frame received but not handled");
  }

  async #handleVideoMessage(message: RealtimeWebsocketMessage) {
    // Decode base64 video data
    const videoData = message.payload.data;
    let frameData: Uint8Array;

    if (typeof videoData === "string") {
      // If data is base64 encoded string, decode it
      const binaryString = atob(videoData);
      frameData = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        frameData[i] = binaryString.charCodeAt(i);
      }
    } else if (
      videoData &&
      typeof videoData === "object" &&
      "buffer" in videoData
    ) {
      // If data is already a Uint8Array or similar typed array
      frameData = videoData as Uint8Array;
    } else {
      console.error("Invalid video data format");
      return;
    }

    // For now, video frames are not handled by default
    // Users can override onMediaFrame if needed
    console.warn("Video frame received but not handled");
  }

  override getConnectionTags(
    connection: Connection,
    ctx: ConnectionContext
  ): string[] {
    if (ctx.request.url.endsWith("/realtime/ws")) {
      return [REALTIME_WS_TAG];
    }
    return super.getConnectionTags(connection, ctx);
  }

  /**
   * Send text to speak through the realtime pipeline
   * @param text The text to send
   * @param contextId The context id of the message
   */
  async speak(text: string, contextId?: string) {
    const connections = this.getConnections(REALTIME_WS_TAG);

    let connCount = 0;

    let message: RealtimeWebsocketMessage | string = {
      type: "media",
      version: 1,
      identifier: randomUUID(),
      payload: {
        content_type: "text",
        context_id: contextId,
        data: text
      }
    };

    message = JSON.stringify(message);

    for (const conn of connections) {
      try {
        connCount++;
        conn.send(message);
      } catch (e) {
        console.error("failed to send text to agent", e);
      }
    }
    if (connCount === 0)
      throw new Error("no connections to realtime agent found");
  }
}
