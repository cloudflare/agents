import { Agent as OpenAIAgent, run, tool } from "@openai/agents";
import type { AgentInputItem } from "@openai/agents";
import { Agent as CFAgent, callable, routeAgentRequest } from "agents";
import type { StreamingResponse } from "agents";
import { z } from "zod";

export type { AgentInputItem };

/** A streaming chunk sent to the client via StreamingResponse.send() */
export type StreamChunk =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-result"; toolCallId: string; output: unknown };

export type AgentState = {
  messages: AgentInputItem[];
};

const getWeather = tool({
  name: "get_weather",
  description: "Get the current weather for a city",
  parameters: z.object({
    city: z.string().describe("The city name")
  }),
  execute: async ({ city }) => {
    const conditions = ["sunny", "cloudy", "rainy", "windy"];
    const temp = Math.floor(Math.random() * 30) + 5;
    return JSON.stringify({
      city,
      temperature: `${temp}°C`,
      condition: conditions[Math.floor(Math.random() * conditions.length)]
    });
  }
});

/**
 * Streaming chat agent using @openai/agents with @callable({ streaming: true }).
 *
 * The pattern:
 *   1. Client calls agent.call("chat", [message], { stream: { onChunk, onDone } })
 *   2. Server receives a StreamingResponse as the first argument
 *   3. run(agent, history, { stream: true }) produces a StreamedRunResult
 *   4. For each event, stream.send() pushes typed chunks to the client
 *   5. stream.end() signals completion with the full assistant message
 */
export class MyAgent extends CFAgent<Env, AgentState> {
  initialState: AgentState = { messages: [] };

  @callable({ streaming: true })
  async chat(stream: StreamingResponse, userMessage: string) {
    const agent = new OpenAIAgent({
      name: "Assistant",
      instructions:
        "You are a helpful assistant. You can check the weather for any city.",
      tools: [getWeather]
    });

    const messages: AgentInputItem[] = [
      ...this.state.messages,
      { role: "user" as const, content: userMessage }
    ];

    const result = await run(agent, messages, { stream: true });

    let assistantText = "";
    const newItems: AgentInputItem[] = [];
    // Track tool names by callId so we can pair them with results
    const toolNames = new Map<string, string>();

    for await (const event of result) {
      if (event.type === "raw_model_stream_event") {
        if (event.data.type === "output_text_delta") {
          assistantText += event.data.delta;
          stream.send({
            type: "text-delta",
            delta: event.data.delta
          } satisfies StreamChunk);
        }
      }

      if (event.type === "run_item_stream_event") {
        if (event.name === "tool_called") {
          const rawItem = event.item.rawItem as {
            callId: string;
            name: string;
            arguments: string;
          };
          toolNames.set(rawItem.callId, rawItem.name);
          newItems.push({
            type: "function_call" as const,
            callId: rawItem.callId,
            name: rawItem.name,
            arguments: rawItem.arguments
          });
          stream.send({
            type: "tool-call",
            toolCallId: rawItem.callId,
            toolName: rawItem.name,
            input: JSON.parse(rawItem.arguments)
          } satisfies StreamChunk);
        } else if (event.name === "tool_output") {
          const rawItem = event.item.rawItem as {
            callId: string;
            output: unknown;
          };
          newItems.push({
            type: "function_call_result" as const,
            callId: rawItem.callId,
            name: toolNames.get(rawItem.callId) ?? "unknown",
            status: "completed" as const,
            output:
              typeof rawItem.output === "string"
                ? rawItem.output
                : JSON.stringify(rawItem.output)
          });
          stream.send({
            type: "tool-result",
            toolCallId: rawItem.callId,
            output: rawItem.output
          } satisfies StreamChunk);
        }
      }
    }

    newItems.push({
      role: "assistant" as const,
      status: "completed" as const,
      content: [{ type: "output_text" as const, text: assistantText }]
    });
    this.setState({ messages: [...messages, ...newItems] });
    stream.end();
  }

  @callable()
  clearHistory() {
    this.setState({ messages: [] });
  }
}

// Worker entrypoint
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
