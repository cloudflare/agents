import { TwilioRealtimeTransportLayer } from "@openai/agents-extensions";
import { RealtimeAgent, RealtimeSession } from "@openai/agents/realtime";
import {
  Agent,
  type Connection,
  type ConnectionContext,
  routeAgentRequest
} from "agents";

export class MyAgent extends Agent {
  // don't use hibernation, the dependencies will manually add their own handlers
  static options = { hibernate: false };

  async onConnect(connection: Connection, ctx: ConnectionContext) {
    if (ctx.request.url.includes("media-stream")) {
      const agent = new RealtimeAgent({
        instructions:
          "You are a helpful assistant that starts every conversation with a creative greeting.",
        name: "Triage Agent"
      });

      connection.send(`Welcome! You are connected with ID: ${connection.id}`);

      const twilioTransportLayer = new TwilioRealtimeTransportLayer({
        twilioWebSocket: connection
      });

      const session = new RealtimeSession(agent, {
        transport: twilioTransportLayer
      });

      await session.connect({
        apiKey: process.env.OPENAI_API_KEY as string
      });

      session.on("history_updated", (history) => {
        this.setState({ history });
      });
    }
  }
  onMessage() {} // just a blank, the transport layer will add its own handlers
  onClose(connection: Connection) {
    connection.close();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/incoming-call" && request.method === "POST") {
      const twimlResponse = `
<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>O.K. you can start talking!</Say>
    <Connect>
        <Stream url="wss://call-my-agent.threepointone.workers.dev/agents/my-agent/123/media-stream" />
    </Connect>
</Response>`.trim();
      return new Response(twimlResponse, {
        headers: {
          "Content-Type": "text/xml"
        }
      });
    }
    return (
      (await routeAgentRequest(request, env, { cors: true })) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
