import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

type State = { totalCalls: number };

const IDLE_TIMEOUT_SECONDS = 15 * 60;
const IDLE_CALLBACK = "onIdleTimeout";

/**
 * MCP servers use HTTP (not WebSocket), so they can't use PlaygroundAgent's
 * onConnect/onClose idle timeout. Instead, each tool call resets a 15-minute
 * self-destruct schedule. If no tools are called before it fires, the agent
 * destroys itself to free storage from abandoned demo sessions.
 */
export class PlaygroundMcpServer extends McpAgent<Env, State, {}> {
  server = new McpServer({
    name: "Playground MCP Server",
    version: "1.0.0"
  });

  initialState: State = { totalCalls: 0 };

  private resetIdleTimer() {
    for (const schedule of this.getSchedules()) {
      if (schedule.callback === IDLE_CALLBACK) {
        this.cancelSchedule(schedule.id);
      }
    }
    this.schedule(IDLE_TIMEOUT_SECONDS, IDLE_CALLBACK, {});
  }

  async onIdleTimeout() {
    await this.destroy();
  }

  async init() {
    this.server.registerTool(
      "roll_dice",
      {
        description: "Roll one or more dice with a given number of sides",
        inputSchema: {
          sides: z.number().min(2).max(100).default(6),
          count: z.number().min(1).max(20).default(1)
        }
      },
      async ({ sides, count }) => {
        this.resetIdleTimer();
        const rolls = Array.from(
          { length: count },
          () => Math.floor(Math.random() * sides) + 1
        );
        this.setState({
          totalCalls: this.state.totalCalls + 1
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                rolls,
                total: rolls.reduce((a, b) => a + b, 0),
                sides,
                count
              })
            }
          ]
        };
      }
    );

    this.server.registerTool(
      "generate_uuid",
      {
        description: "Generate one or more random UUIDs",
        inputSchema: {
          count: z.number().min(1).max(10).default(1)
        }
      },
      async ({ count }) => {
        this.resetIdleTimer();
        const uuids = Array.from({ length: count }, () => crypto.randomUUID());
        this.setState({
          totalCalls: this.state.totalCalls + 1
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ uuids })
            }
          ]
        };
      }
    );

    this.server.registerTool(
      "word_count",
      {
        description: "Count words, characters, and lines in text",
        inputSchema: {
          text: z.string()
        }
      },
      async ({ text }) => {
        this.resetIdleTimer();
        const words = text.trim().split(/\s+/).filter(Boolean).length;
        const characters = text.length;
        const lines = text.split("\n").length;
        this.setState({
          totalCalls: this.state.totalCalls + 1
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ words, characters, lines })
            }
          ]
        };
      }
    );

    this.server.registerTool(
      "hash_text",
      {
        description: "Compute SHA-256 hash of text",
        inputSchema: {
          text: z.string()
        }
      },
      async ({ text }) => {
        this.resetIdleTimer();
        const encoder = new TextEncoder();
        const data = encoder.encode(text);
        const hashBuffer = await crypto.subtle.digest("SHA-256", data);
        const hash = Array.from(new Uint8Array(hashBuffer))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        this.setState({
          totalCalls: this.state.totalCalls + 1
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ hash }) }]
        };
      }
    );

    this.server.resource(
      "server_info",
      "playground://server-info",
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(
              {
                name: "Playground MCP Server",
                version: "1.0.0",
                totalCalls: this.state.totalCalls,
                tools: ["roll_dice", "generate_uuid", "word_count", "hash_text"]
              },
              null,
              2
            )
          }
        ]
      })
    );
  }
}
