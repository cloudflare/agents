import { randomUUID } from "node:crypto";
import { Agent, type Connection, type ConnectionContext } from ".";
import {
  RealtimeKitTransport,
  TextProcessor,
  type RealtimePipelineComponent
} from "./realtime-components";

// export const REALTIME_AGENTS_SERVICE = "https://agents.realtime.cloudflare.com";
export const REALTIME_AGENTS_SERVICE = "https://kind-waves-give.loca.lt";
export const CLOUDFLARE_BASE = "https://api.cloudflare.com";
export const REALTIME_WS_TAG = "realtime_websocket";

export function isRealtimeWebsocketMessage(
  msg: unknown
): msg is RealtimeWebsocketMessage {
  const m = msg as any;
  const p = m?.payload as any;
  return (
    typeof msg === "object" &&
    msg !== null &&
    "type" in m &&
    typeof m.type === "string" &&
    "version" in m &&
    typeof m.version === "number" &&
    "identifier" in m &&
    typeof m.identifier === "string" &&
    "payload" in m &&
    typeof m.payload === "object" &&
    m.payload !== null &&
    "content_type" in p &&
    typeof p.content_type === "string" &&
    "context_id" in p &&
    typeof p.context_id === "string" &&
    "data" in p &&
    typeof p.data === "string"
  );
}

export function isRealtimeRequest(request: Request): boolean {
  const url = new URL(request.url);
  const split = url.pathname.split("realtime");
  return split.length > 2;
}

export async function* processNDJSONStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  leftOverBuffer = ""
) {
  const decoder = new TextDecoder();
  let buffer = leftOverBuffer;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim()) {
        if (line.startsWith("data: ")) {
          const jsonLine = line.slice(6).trim();
          if (jsonLine === "[DONE]") {
            return; // End of stream
          }
          yield JSON.parse(jsonLine);
        }
      }
    }
  }

  // Handle leftover buffer
  if (buffer.trim()) {
    const lines = buffer.split("\n").filter((line) => line.trim());
    if (lines.length > 1) {
      /**
       * This case usually happens when leftOverBuffer has more than 1 line
       * and the reader returned DONE;
       */
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const jsonLine = line.slice(6).trim();
          if (jsonLine === "[DONE]") {
            return; // End of stream
          }
          yield JSON.parse(jsonLine);
        }
      }
    } else if (buffer.startsWith("data: ")) {
      const jsonLine = buffer.slice(6).trim();
      if (jsonLine === "[DONE]") {
        return; // End of stream
      }
      yield JSON.parse(jsonLine);
    }
  }
}

/**
 * Websocket message type for realtime
 */
export type RealtimeWebsocketMessage = {
  type: string;
  version: number;
  identifier: string;
  payload: {
    content_type: string;
    context_id: string;
    data: string;
  };
};

export class Realtime {
  components: RealtimePipelineComponent[];
  auth_token?: string;
  flow_id?: string;
  cf_account_id: string;
  cf_api_token: string;
  agentId: string;
  agentName: string;
  is_running: boolean = false;

  constructor(
    components: RealtimePipelineComponent[],
    opts: {
      CF_ACCOUNT_ID: string;
      CF_API_TOKEN: string;
      agentId: string;
      agentName: string;
    }
  ) {
    this.components = components;
    this.cf_account_id = opts.CF_ACCOUNT_ID;
    this.cf_api_token = opts.CF_API_TOKEN;
    this.agentId = opts.agentId;
    this.agentName = opts.agentName;
  }

  async init(agentURL: string) {
    let last_component: RealtimePipelineComponent | undefined;
    for (const component of this.components) {
      if (
        last_component &&
        last_component.output_kind() !== component.input_kind()
      ) {
        throw new Error(
          `cannot link up component of output kind ${last_component.output_kind()} with one of input kind ${component.input_kind()}`
        );
      }
      last_component = component;
    }

    // We need to check if the components array have any instance of
    // Agent or TextProcessor, in that case we need to split the components
    // into two layers, where the first layers end at that component
    // and the second layer starts from that component. The Agent/TextProcessor
    // are websocket element, we will be using bidirectional websocket so only
    // one websocket element will be acting as input and output both.

    const layers: { id: number; name: string; elements: string[] }[] = [
      {
        id: 1,
        name: "default",
        elements: []
      }
    ];
    let elements: { name: string; [K: string]: unknown }[] = [];

    for (const component of this.components) {
      const schema = component.schema();
      if (component instanceof Agent || component instanceof TextProcessor) {
        if (component instanceof Agent) {
          schema.type = "websocket";
          // we also handle events from the pipeline in agents class
          schema.send_events = true;
          schema.url = `wss://${agentURL}`;
        }
        layers[layers.length - 1].elements.push(schema.name);

        layers.push({
          id: layers.length + 1,
          name: `default-${layers.length + 1}`,
          elements: []
        });
      }

      if (component instanceof RealtimeKitTransport) {
        schema.worker_url = `https://${agentURL}`;
      }
      elements.push(schema);
      layers[layers.length - 1].elements.push(schema.name);
    }

    elements = elements.filter(
      (v, idx, arr) => idx === arr.findIndex((v1) => v1.name === v.name)
    );

    console.log("layers", layers, "elements", elements);

    const response = await fetch(
      // `${CLOUDFLARE_BASE}/client/v4/accounts/${CF_ACCOUNT_ID}/realtime/agents/pipeline`,
      `${REALTIME_AGENTS_SERVICE}/pipeline`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.cf_api_token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          event: "pipeline.provision",
          id: randomUUID(),
          elements,
          layers
        })
      }
    );
    const { id, token } = await response.json<{ id: string; token: string }>();
    if (!id || !token) throw new Error("invalid response from streamline");
    console.log("pipeline provisioned", id, token);
    // TODO: need to store these values in storage
    this.flow_id = id;
    this.auth_token = token;
    await this.components
      .filter((c) => c instanceof RealtimeKitTransport)[0]
      .init(token);

    const meetingTranport = this.components.filter(
      (c) => c instanceof RealtimeKitTransport
    );
    if (meetingTranport.length > 0) {
      meetingTranport[0].meeting.self.on("roomLeft", () =>
        this.stopRealtimePipeline()
      );
    }
  }

  async dispose() {
    if (this.is_running) return this.stopRealtimePipeline();
  }

  /**
   * Start the agent
   */
  async startRealtimePipeline(agentURL: string) {
    // check if instance is already started
    if (this.is_running) throw new Error("agent is already running");

    await this.init(agentURL);
    this.is_running = true;

    const startResponse = await fetch(
      `${REALTIME_AGENTS_SERVICE}/pipeline?authToken=${this.auth_token}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          action: "start"
        })
      }
    );
    const { success } = await startResponse.json<{ success: boolean }>();
    if (!success) throw new Error("failed to start pipeline");
    this.is_running = true;
  }

  /**
   * Stop the agent
   */
  async stopRealtimePipeline() {
    if (!this.is_running) throw new Error("agent not running");
    const meetingTransports = this.components.filter(
      (c) => c instanceof RealtimeKitTransport
    );
    if (meetingTransports.length > 0) {
      if (meetingTransports[0].meeting.self.roomJoined)
        meetingTransports[0].meeting.leave();
    }
    const response = await fetch(
      `${REALTIME_AGENTS_SERVICE}/pipeline?authToken=${this.auth_token}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          action: "stop"
        })
      }
    );
    const { success } = await response.json<{ success: boolean }>();
    if (!success) throw new Error("failed to stop agent");
    this.is_running = false;
  }

  async handleWebsocketMessage(message: unknown): Promise<boolean> {
    if (!isRealtimeWebsocketMessage(message)) return false;

    if (message.type === "media") {
      switch (message.payload.content_type) {
        case "text":
          const agentClass = this.components.filter((c) => c instanceof Agent);

          if (agentClass.length > 0) {
            agentClass[0].onRealtimeTranscript(
              message.payload.data,
              async (text, canInterrupt) => {
                let contextId = undefined;

                if (canInterrupt === undefined) {
                  canInterrupt = true;
                }

                if (canInterrupt) {
                  contextId = message.payload.context_id;
                }

                if (typeof text === "string") {
                  agentClass[0].speak(text, contextId);
                  return;
                }

                for await (const chunk of processNDJSONStream(
                  text.getReader()
                )) {
                  if (!chunk.response) continue;
                  agentClass[0].speak(chunk.response, contextId);
                }
              }
            );
          }

          break;
        case "audio":
          break;
        case "video":
          break;
      }
    }

    return true;
  }

  async handleRequests(request: Request): Promise<Response> {
    const requestUrl = new URL(request.url);
    const agentURL = `${requestUrl.host}/agents/${this.agentName}/${this.agentId}/realtime`;

    const path = request.url.split("realtime")[1];
    switch (path) {
      case "/rtk/produce": {
        const payload = await request.json<{
          producingTransportId: string;
          producerId: string;
          kind: string;
        }>();
        const meeting = this.components.filter(
          (c) => c instanceof RealtimeKitTransport
        )[0].meeting!;
        if (meeting.self.roomJoined) {
          console.log("bot joined the meeting");
          await meeting.self.produce(payload);
        } else {
          console.log("bot not joined the meeting");
          meeting.self.on("roomJoined", () => meeting.self.produce(payload));
        }
        return new Response(null, { status: 200 });
      }
      case "/start": {
        await this.startRealtimePipeline(agentURL);
        return new Response(null, { status: 200 });
      }
      case "/stop": {
        await this.stopRealtimePipeline();
        return new Response(null, { status: 200 });
      }
    }

    return new Response(null, { status: 404 });
  }

  getConnectionTags(connection: Connection, ctx: ConnectionContext) {
    return [REALTIME_WS_TAG];
  }
}
