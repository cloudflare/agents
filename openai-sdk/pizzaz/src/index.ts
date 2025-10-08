import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Adapted from https://developers.openai.com/apps-sdk/build/examples
export class PizzazMcp extends McpAgent {
  server = new McpServer({ name: "Pizzaz", version: "v1.0.0" });

  async init() {
    this.server.registerResource(
      "pizzaz-map",
      "ui://widget/pizzaz-map.html",
      {},
      async () => ({
        contents: [
          {
            uri: "ui://widget/pizzaz-map.html",
            mimeType: "text/html+skybridge",
            text: `
      <div id="pizzaz-root"></div>
      <link rel="stylesheet" href="https://persistent.oaistatic.com/ecosystem-built-assets/pizzaz-0038.css">
      <script type="module" src="https://persistent.oaistatic.com/ecosystem-built-assets/pizzaz-0038.js"></script>
              `.trim()
          }
        ]
      })
    );

    this.server.registerTool(
      "pizzaz-map",
      {
        title: "Show Pizza Map",
        _meta: {
          "openai/outputTemplate": "ui://widget/pizzaz-map.html",
          "openai/toolInvocation/invoking": "Hand-tossing a map",
          "openai/toolInvocation/invoked": "Served a fresh map"
        },
        inputSchema: { pizzaTopping: z.string() }
      },
      async () => {
        return {
          content: [{ type: "text", text: "Rendered a pizza map!" }],
          structuredContent: {}
        };
      }
    );

    this.server.registerResource(
      "pizzaz-carousel",
      "ui://widget/pizzaz-carousel.html",
      {},
      async () => ({
        contents: [
          {
            uri: "ui://widget/pizzaz-carousel.html",
            mimeType: "text/html+skybridge",
            text: `
      <div id="pizzaz-carousel-root"></div>
      <link rel="stylesheet" href="https://persistent.oaistatic.com/ecosystem-built-assets/pizzaz-carousel-0038.css">
      <script type="module" src="https://persistent.oaistatic.com/ecosystem-built-assets/pizzaz-carousel-0038.js"></script>
              `.trim()
          }
        ]
      })
    );

    this.server.registerTool(
      "pizzaz-carousel",
      {
        title: "Show Pizza Carousel",
        _meta: {
          "openai/outputTemplate": "ui://widget/pizzaz-carousel.html",
          "openai/toolInvocation/invoking": "Carousel some spots",
          "openai/toolInvocation/invoked": "Served a fresh carousel"
        },
        inputSchema: { pizzaTopping: z.string() }
      },
      async () => {
        return {
          content: [{ type: "text", text: "Rendered a pizza carousel!" }],
          structuredContent: {}
        };
      }
    );

    this.server.registerResource(
      "pizzaz-albums",
      "ui://widget/pizzaz-albums.html",
      {},
      async () => ({
        contents: [
          {
            uri: "ui://widget/pizzaz-albums.html",
            mimeType: "text/html+skybridge",
            text: `
      <div id="pizzaz-albums-root"></div>
      <link rel="stylesheet" href="https://persistent.oaistatic.com/ecosystem-built-assets/pizzaz-albums-0038.css">
      <script type="module" src="https://persistent.oaistatic.com/ecosystem-built-assets/pizzaz-albums-0038.js"></script>
              `.trim()
          }
        ]
      })
    );

    this.server.registerTool(
      "pizzaz-albums",
      {
        title: "Show Pizza Album",
        _meta: {
          "openai/outputTemplate": "ui://widget/pizzaz-albums.html",
          "openai/toolInvocation/invoking": "Hand-tossing an album",
          "openai/toolInvocation/invoked": "Served a fresh album"
        },
        inputSchema: { pizzaTopping: z.string() }
      },
      async () => {
        return {
          content: [{ type: "text", text: "Rendered a pizza album!" }],
          structuredContent: {}
        };
      }
    );

    this.server.registerResource(
      "pizzaz-list",
      "ui://widget/pizzaz-list.html",
      {},
      async () => ({
        contents: [
          {
            uri: "ui://widget/pizzaz-list.html",
            mimeType: "text/html+skybridge",
            text: `
      <div id="pizzaz-list-root"></div>
      <link rel="stylesheet" href="https://persistent.oaistatic.com/ecosystem-built-assets/pizzaz-list-0038.css">
      <script type="module" src="https://persistent.oaistatic.com/ecosystem-built-assets/pizzaz-list-0038.js"></script>
              `.trim()
          }
        ]
      })
    );

    this.server.registerTool(
      "pizzaz-list",
      {
        title: "Show Pizza List",
        _meta: {
          "openai/outputTemplate": "ui://widget/pizzaz-list.html",
          "openai/toolInvocation/invoking": "Hand-tossing a list",
          "openai/toolInvocation/invoked": "Served a fresh list"
        },
        inputSchema: { pizzaTopping: z.string() }
      },
      async () => {
        return {
          content: [{ type: "text", text: "Rendered a pizza list!" }],
          structuredContent: {}
        };
      }
    );

    this.server.registerResource(
      "pizzaz-video",
      "ui://widget/pizzaz-video.html",
      {},
      async () => ({
        contents: [
          {
            uri: "ui://widget/pizzaz-video.html",
            mimeType: "text/html+skybridge",
            text: `
      <div id="pizzaz-video-root"></div>
      <link rel="stylesheet" href="https://persistent.oaistatic.com/ecosystem-built-assets/pizzaz-video-0038.css">
      <script type="module" src="https://persistent.oaistatic.com/ecosystem-built-assets/pizzaz-video-0038.js"></script>
              `.trim()
          }
        ]
      })
    );

    this.server.registerTool(
      "pizzaz-video",
      {
        title: "Show Pizza Video",
        _meta: {
          "openai/outputTemplate": "ui://widget/pizzaz-video.html",
          "openai/toolInvocation/invoking": "Hand-tossing a video",
          "openai/toolInvocation/invoked": "Served a fresh video"
        },
        inputSchema: { pizzaTopping: z.string() }
      },
      async () => {
        return {
          content: [{ type: "text", text: "Rendered a pizza video!" }],
          structuredContent: {}
        };
      }
    );
  }
}

// This is literally all there is to our Worker
export default PizzazMcp.serve("/");
