import type RealtimeKitClient from "@cloudflare/realtimekit";
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
  DataKind,
  RealtimeKitTransport,
  type RealtimePipelineComponent,
  type WebSocketPipelineComponent
} from "./components";
import { camelCaseToKebabCase } from "../client";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

// Re-export pipeline schema types and function from separate file for testability
export {
  buildPipelineSchema,
  type PipelineSchemaConfig,
  type PipelineLayer,
  type PipelineSchemaResult
} from "./pipeline-schema";

// Import for internal use
import { buildPipelineSchema } from "./pipeline-schema";

export type SpeakResponse = {
  text:
    | string
    | ReadableStream<Uint8Array>
    | (AsyncIterable<string> & ReadableStream<string>);
  canInterrupt?: boolean;
};

export type RealtimeSnapshot = {
  pipelineState: RealtimeState;
  flowId?: string;
};

export class RealtimeAgent<Env extends Cloudflare.Env, State = unknown>
  extends Agent<Env, State>
  implements WebSocketPipelineComponent
{
  public pipelineState: RealtimeState = "idle";
  private api?: RealtimeAPI;
  private pipeline: RealtimePipelineComponent[] = [];
  private agentUrl?: string;
  private token?: string;
  private agentName: string;
  /** Last audio frame received from the pipeline */
  public lastAudioFrame?: Buffer;
  /** Last video frame received from the pipeline */
  public lastVideoFrame?: Buffer;
  /** Current flow ID for the conversation */
  public flowId?: string;

  #meeting?: RealtimeKitClient;

  onError(error: unknown): void | Promise<void> {
    console.error("Error in realtime agent", error);
  }

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    // Get the agent name from the class constructor
    this.agentName = camelCaseToKebabCase(
      Object.getPrototypeOf(this).constructor.name
    );

    if (!this.ctx.storage.get("keepAlive")) {
      this.keepAlive();
    }

    const _onMessage = this.onMessage.bind(this);

    this.onMessage = async (connection: Connection, message: WSMessage) => {
      if (typeof message !== "string") {
        return _onMessage(connection, message);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(message);
      } catch (_e) {
        // Not JSON, pass to parent
        return _onMessage(connection, message);
      }

      if (isRealtimeWebsocketMessage(parsed)) {
        const connections = this.getConnections(REALTIME_WS_TAG);

        const isServer = Array.from(connections).some(
          (conn) => conn.id === connection.id
        );

        if (isServer) {
          // Message from streamline server → handle locally
          await this.handleWebsocketMessage(parsed);
          return;
        }

        this.storeMediaClientConnId(connection);

        // Message from client → forward to streamline server
        this.sendToServer(message);
        return;
      }

      return _onMessage(connection, message);
    };

    const _getConnectionTags = this.getConnectionTags.bind(this);

    this.getConnectionTags = (
      connection: Connection,
      ctx: ConnectionContext
    ) => {
      if (ctx.request.url.endsWith("/realtime/ws")) {
        return [REALTIME_WS_TAG];
      }
      return _getConnectionTags(connection, ctx);
    };

    const _onClose = this.onClose.bind(this);
    this.onClose = async (
      connection: Connection,
      codc: number,
      reason: string,
      wasClean: boolean
    ) => {
      try {
        await this.removeMediaClientConnId(connection.id);
      } catch (e) {
        console.error("Failed to remove media client conn id", e);
      }

      await _onClose(connection, codc, reason, wasClean);
    };
  }

  private storeMediaClientConnId(connection: Connection) {
    this.ctx.storage.put("mediaClientConnId", connection.id);
  }

  private async removeMediaClientConnId(id: string) {
    const storedId = await this.getMediaClientConnId();
    if (storedId && storedId === id) {
      this.ctx.storage.delete("mediaClientConnId");
    }
  }

  private async getMediaClientConnId(): Promise<string | undefined> {
    return this.ctx.storage.get("mediaClientConnId");
  }

  public setPipeline(
    pipeline: RealtimePipelineComponent[],
    ai: Ai,
    gatewayId?: string
  ) {
    const gatewayIdOrDefault = gatewayId ?? ":default";
    this.api = new RealtimeAPI(ai, gatewayIdOrDefault);

    for (const component of pipeline) {
      component.setGatewayId?.(gatewayIdOrDefault);
    }
    this.pipeline = pipeline;
  }

  /**
   * Possibly undefined if no rtk element is configured.
   */
  get rtkMeeting(): RealtimeKitClient | undefined {
    return this.#meeting;
  }

  async keepAlive() {
    this.ctx.storage.put("keepAlive", true);
    this.schedule(10, "keepAlive");
  }

  async cancelKeepAlive() {
    this.ctx.storage.delete("keepAlive");
    this.cancelSchedule("keepAlive");
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
   * Called when the Agent receives a raw audio frame from the Realtime pipeline.
   * Override this method to handle incoming audio frames.
   * Use this.speak() to send a text response if needed.
   * @param frame The raw audio frame data (base64-decoded)
   */
  async onRealtimeAudio(frame: Buffer): Promise<void> {
    return;
  }

  /**
   * Called when the Agent receives a video frame from the Realtime pipeline.
   * Override this method to handle incoming video frames.
   * Use this.speak() to send a text response if needed.
   * @param frame The video frame data (base64-decoded)
   */
  async onRealtimeVideoFrame(frame: Buffer): Promise<void> {
    return;
  }

  /**
   * Initialize the realtime pipeline
   * @param agentURL The URL of the agent
   */
  async init(agentURL: string, meetingId: string | null) {
    if (!this.api) {
      throw new Error("setPipeline must be called before init");
    }

    // Build pipeline schema using the extracted pure function
    const parentClassName = Object.getPrototypeOf(this).constructor.name;
    const { layers, elements, realtimeKitComponent } = buildPipelineSchema({
      pipeline: this.pipeline,
      agentUrl: agentURL,
      parentClassName,
      meetingId
    });

    console.log(
      `[Pipeline configuration]: layers: ${JSON.stringify(layers)}, elements: ${JSON.stringify(elements)}`
    );

    // Create pipeline
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
      const realtimeKitElement = newElements.find(
        (e) => e.name === realtimeKitComponent.name
      );
      if (!realtimeKitElement) {
        throw new Error("RealtimeKit element not found in pipeline");
      }
      const authToken = realtimeKitElement.auth_token;
      if (typeof authToken !== "string") {
        throw new Error(
          "RealtimeKit element missing auth_token in pipeline response"
        );
      }
      realtimeKitComponent.authToken = authToken;
    }
  }

  /**
   * Start the realtime pipeline
   * This will initialize the pipeline and start processing
   */
  async startRealtimePipeline(meetingId: string | null) {
    if (!this.api) {
      throw new Error(
        "setPipeline must be called before startRealtimePipeline"
      );
    }
    if (this.pipelineState !== "idle") {
      throw new Error("Pipeline is already running");
    }

    this.pipelineState = "initializing";

    if (!this.agentUrl) {
      throw new Error("Agent URL not set. Call buildAgentUrl first.");
    }

    await this.init(this.agentUrl, meetingId);

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
    if (!this.api) {
      throw new Error("setPipeline must be called before stopRealtimePipeline");
    }
    if (
      this.pipelineState !== "running" &&
      this.pipelineState !== "initializing"
    ) {
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
    this.pipelineState = "idle";
    this.cancelKeepAlive();
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

    const path = requestUrl.pathname.split(
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
        const meetingId = requestUrl.searchParams.get("meetingId");
        await this.startRealtimePipeline(meetingId);
        return Response.json({ success: true });
      }

      case "/stop": {
        await this.stopRealtimePipeline();
        return Response.json({ success: true });
      }

      case "/ping": {
        return new Response(null, {
          status: 200,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
          }
        });
      }

      default:
        return new Response("Not found", { status: 404 });
    }
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

    const response = await this.onRealtimeTranscript(userText);

    if (!response) return;

    // if a user can interrupt whatever bot is speaking
    if (!response.canInterrupt) {
      contextId = undefined;
    }

    if (typeof response.text === "string") {
      this.speak(response.text, contextId);
      return;
    }

    // Handle AI SDK streamText output (AsyncIterable<string>)
    // Check if it's an AsyncIterable that yields strings directly (AI SDK textStream)
    if (Symbol.asyncIterator in response.text) {
      for await (const chunk of response.text as AsyncIterable<string>) {
        if (typeof chunk === "string" && chunk) {
          this.speak(chunk, contextId);
        }
      }
      return;
    }

    if (response.text instanceof ReadableStream) {
      // Handle ReadableStream<Uint8Array> (NDJSON format)
      const stream = response.text;
      for await (const chunk of processNDJSONStream(stream.getReader())) {
        if (chunk.response) {
          this.speak(chunk.response, contextId);
        } else if (chunk.choices && chunk.choices.length > 0) {
          const choice = chunk.choices[0];
          if (choice.delta?.content && choice.delta?.role === "assistant") {
            this.speak(choice.delta.content, contextId);
          }
        }
      }
      return;
    }
  }

  async #handleAudioMessage(message: RealtimeWebsocketMessage) {
    const clientConnId = await this.getMediaClientConnId();
    if (clientConnId) {
      const connection = this.getConnection(clientConnId);
      if (connection) {
        connection.send(JSON.stringify(message));
      }
      return;
    }

    const frameData = Buffer.from(message.payload.data, "base64");

    this.lastAudioFrame = frameData;

    await this.onRealtimeAudio(frameData);
  }

  async #handleVideoMessage(message: RealtimeWebsocketMessage) {
    const frameData = Buffer.from(message.payload.data, "base64");
    this.lastVideoFrame = frameData;
    await this.onRealtimeVideoFrame(frameData);
  }

  private sendToServer(message: WSMessage) {
    const connections = this.getConnections(REALTIME_WS_TAG);

    let connCount = 0;

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

  /**
   * Send text to speak through the realtime pipeline
   * @param text The text to send
   * @param contextId The context id of the message
   */
  async speak(text: string, contextId?: string) {
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

    this.sendToServer(message);
  }

  get url(): string | undefined {
    return this.agentUrl ? `wss://${this.agentUrl}/ws` : undefined;
  }

  input_kind(): DataKind[] {
    return [DataKind.Text, DataKind.Audio, DataKind.Video];
  }

  output_kind(): DataKind[] {
    return [DataKind.Text, DataKind.Audio, DataKind.Video];
  }

  schema() {
    return {
      name: "agent",
      type: "websocket",
      send_events: true,
      url: ""
    };
  }
}
