import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import icon from "./mcp-icon.svg";

type Env = {
  MyMCP: DurableObjectNamespace<MyMCP>;
};

type State = { counter: number };

export class MyMCP extends McpAgent<Env, State, {}> {
  server = new McpServer({
    name: "Demo",
    version: "1.0.0",
    // Add icons and website URL to the server implementation
    icons: [
      {
        src: icon,
        sizes: "any",
        mimeType: "image/svg+xml"
      }
    ],
    websiteUrl: "https://github.com/cloudflare/agents"
  });

  initialState: State = {
    counter: 1
  };

  async init() {
    // Register resource - Note: Current MCP SDK doesn't support icons in resource method yet
    // Icons are supported at the server implementation level

    this.server.registerTool(
      "get_client_capabilities",
      {
        title: "Get client capabilities",
        description: "Get the client capabilities"
      },
      async () => {
        const capabilities = this.server.server.getClientCapabilities();
        if (!capabilities) {
          return { content: [{ type: "text", text: "No capabilities" }] };
        }
        return {
          content: [
            { type: "text", text: JSON.stringify(capabilities, null, 2) }
          ]
        };
      }
    );

    this.server.resource("counter", "mcp://resource/counter", (uri) => {
      return {
        contents: [{ text: String(this.state.counter), uri: uri.href }]
      };
    });

    this.server.registerTool(
      "ask_for_poem",
      {
        title: "Ask for poem",
        description: "Ask for a poem"
      },
      async () => {
        const capabilities = this.server.server.getClientCapabilities();
        if (!capabilities?.sampling) {
          return {
            content: [{ type: "text", text: "You do not support sampling" }]
          };
        }

        console.log("Starting sampling");

        const result = await this.server.server.createMessage({
          systemPrompt: "You are good at poetry and really like dogs",
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: "Please write me a poem"
              }
            }
          ],
          maxTokens: 100
        });

        return { content: [result.content] };
      }
    );

    this.server.registerTool(
      "elicit_feedback",
      {
        title: "Elicit feedback",
        description: "Elicit feedback from the user"
      },
      async () => {
        const capabilities = this.server.server.getClientCapabilities();
        console.log(
          "[ElicitTool] Client capabilities:",
          JSON.stringify(capabilities, null, 2)
        );

        if (!capabilities?.elicitation) {
          console.log(
            "[ElicitTool] Elicitation not supported. Full capabilities:",
            capabilities
          );
          return {
            content: [{ type: "text", text: "You do not support elicitation" }]
          };
        }

        console.log("Starting elicitation");
        console.log("this.elicitInput type:", typeof this.elicitInput);
        console.log("this.elicitInput:", !!this.elicitInput);

        const result = await this.elicitInput({
          message: "Do you like cheese?",
          requestedSchema: {
            type: "object",
            properties: {
              like_cheese: {
                type: "boolean",
                description: "Whether you like cheese"
              }
            }
          }
        });

        if (result.action !== "accept") {
          return {
            content: [{ type: "text", text: "You didn't respond" }]
          };
        }

        return {
          content: [
            {
              type: "text",
              text: result.content?.like_cheese
                ? "You like cheese"
                : "You do not like cheese"
            }
          ]
        };
      }
    );

    // Register tool - Note: Current MCP SDK doesn't support icons in tool method yet
    // Icons are supported at the server implementation level
    this.server.tool(
      "add",
      "Add to the counter, stored in the MCP",
      { a: z.number() },
      async ({ a }) => {
        this.setState({ ...this.state, counter: this.state.counter + a });

        return {
          content: [
            {
              text: String(`Added ${a}, total is now ${this.state.counter}`),
              type: "text"
            }
          ]
        };
      }
    );

    // Note: To fully support icons on tools and resources, you would need to use
    // the server's setRequestHandler method to manually implement the list handlers
    // with icon metadata, as shown in the commented example below:

    /*
    this.server.server.setRequestHandler("tools/list", async () => {
      return {
        tools: [{
          name: "add",
          description: "Add to the counter, stored in the MCP",
          inputSchema: { type: "object", properties: { a: { type: "number" } }, required: ["a"] },
          icons: [{
            src: "data:image/svg+xml;base64,...",
            mimeType: "image/svg+xml",
            sizes: "any"
          }]
        }]
      };
    });
    */
  }

  onStateUpdate(state: State) {
    console.log({ stateUpdate: state });
  }

  onError(_: unknown, error?: unknown): void | Promise<void> {
    console.error("MyMCP initialization error:", error);

    // Provide more specific error messages based on error type
    if (error instanceof Error) {
      if (error.message.includes("counter")) {
        console.error(
          "Failed to initialize counter resource. Please check the counter configuration."
        );
      } else if (error.message.includes("tool")) {
        console.error(
          "Failed to register MCP tools. Please verify tool configurations."
        );
      } else {
        // Fall back to default error handling
        console.error(error);
      }
    }
  }
}

export default {
  fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // support both legacy SSE and new streamable-http

    if (url.pathname.startsWith("/sse")) {
      return MyMCP.serveSSE("/sse", { binding: "MyMCP" }).fetch(
        request,
        env,
        ctx
      );
    }

    if (url.pathname.startsWith("/mcp")) {
      return MyMCP.serve("/mcp", { binding: "MyMCP" }).fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  }
};
