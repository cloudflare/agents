#!/usr/bin/env node

/**
 * HTTP MCP Elicitation Example Server
 *
 * HTTP/SSE server demonstrating interactive user input during tool execution.
 */

import express, { Request, Response, NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

const app = express();
const PORT = 3001;

app.use(express.json());

// CORS middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Expose-Headers", "mcp-session-id");
  if (req.method === "OPTIONS") {
    res.sendStatus(200);
    return;
  }
  next();
});

// Create MCP server instance
const server = new McpServer({
  name: "mcp-elicitation-example-http",
  version: "1.0.0"
});

// Tool 1: Simple confirmation
server.registerTool(
  "delete-file",
  {
    title: "Delete File",
    description: "Delete a file with user confirmation",
    inputSchema: {
      filename: z.string().describe("The file to delete")
    }
  },
  async ({ filename }) => {
    const confirmation = await server.server.elicitInput({
      message: `Are you sure you want to delete "${filename}"?`,
      requestedSchema: {
        type: "object",
        properties: {
          confirmed: {
            type: "boolean",
            title: "Confirm deletion",
            description: "Check to confirm file deletion"
          }
        },
        required: ["confirmed"]
      }
    });

    if (confirmation.action === "accept" && confirmation.content?.confirmed) {
      return {
        content: [
          {
            type: "text",
            text: `File "${filename}" deleted successfully.`
          }
        ]
      };
    } else {
      return {
        content: [
          {
            type: "text",
            text: "File deletion cancelled."
          }
        ]
      };
    }
  }
);

// Tool 2: Multiple choice form
server.registerTool(
  "configure-deployment",
  {
    title: "Configure Deployment",
    description: "Configure deployment settings with multiple choices",
    inputSchema: {
      projectName: z.string().describe("Name of the project to deploy")
    }
  },
  async ({ projectName }) => {
    const config = await server.server.elicitInput({
      message: `Configure deployment for "${projectName}":`,
      requestedSchema: {
        type: "object",
        properties: {
          environment: {
            type: "string",
            title: "Environment",
            enum: ["development", "staging", "production"],
            enumNames: ["Development", "Staging", "Production"]
          },
          region: {
            type: "string",
            title: "AWS Region",
            enum: ["us-east-1", "us-west-2", "eu-west-1"],
            enumNames: ["US East", "US West", "EU West"]
          },
          autoScale: {
            type: "boolean",
            title: "Enable Auto Scaling",
            description: "Automatically scale based on demand"
          }
        },
        required: ["environment", "region", "autoScale"]
      }
    });

    if (config.action === "accept" && config.content) {
      const settings = config.content;
      return {
        content: [
          {
            type: "text",
            text:
              "Deployment configured:\n" +
              `• Project: ${projectName}\n` +
              `• Environment: ${settings.environment}\n` +
              `• Region: ${settings.region}\n` +
              `• Auto Scaling: ${settings.autoScale ? "Enabled" : "Disabled"}`
          }
        ]
      };
    } else {
      return {
        content: [
          {
            type: "text",
            text: "Deployment configuration cancelled."
          }
        ]
      };
    }
  }
);

// Tool 3: Complex form with validation
server.registerTool(
  "create-user-account",
  {
    title: "Create User Account",
    description: "Create a user account with form validation",
    inputSchema: {
      username: z.string().describe("Desired username")
    }
  },
  async ({ username }) => {
    const userInfo = await server.server.elicitInput({
      message: `Create user account for "${username}":`,
      requestedSchema: {
        type: "object",
        properties: {
          email: {
            type: "string",
            format: "email",
            title: "Email Address",
            description: "User's email address"
          },
          fullName: {
            type: "string",
            title: "Full Name",
            description: "User's display name"
          },
          role: {
            type: "string",
            title: "Role",
            enum: ["viewer", "editor", "admin"],
            enumNames: ["Viewer", "Editor", "Admin"]
          },
          sendWelcome: {
            type: "boolean",
            title: "Send Welcome Email",
            description: "Send login instructions to user"
          }
        },
        required: ["email", "fullName", "role"]
      }
    });

    if (userInfo.action === "accept" && userInfo.content) {
      const details = userInfo.content;
      return {
        content: [
          {
            type: "text",
            text:
              "User account created:\n" +
              `• Username: ${username}\n` +
              `• Email: ${details.email}\n` +
              `• Name: ${details.fullName}\n` +
              `• Role: ${details.role}\n` +
              `• Welcome email: ${details.sendWelcome ? "Yes" : "No"}`
          }
        ]
      };
    } else {
      return {
        content: [
          {
            type: "text",
            text: "User account creation cancelled."
          }
        ]
      };
    }
  }
);

// Tool 4: Multi-step workflow
server.registerTool(
  "setup-project",
  {
    title: "Setup Project",
    description: "Setup a new project with multiple configuration steps",
    inputSchema: {
      projectName: z.string().describe("Name of the project")
    }
  },
  async ({ projectName }) => {
    // Step 1: Basic setup
    const basicConfig = await server.server.elicitInput({
      message: `Configure basic settings for "${projectName}":`,
      requestedSchema: {
        type: "object",
        properties: {
          language: {
            type: "string",
            title: "Programming Language",
            enum: ["javascript", "typescript", "python", "go"],
            enumNames: ["JavaScript", "TypeScript", "Python", "Go"]
          },
          framework: {
            type: "string",
            title: "Framework",
            enum: ["react", "vue", "express", "fastapi"],
            enumNames: ["React", "Vue", "Express", "FastAPI"]
          }
        },
        required: ["language", "framework"]
      }
    });

    if (basicConfig.action !== "accept") {
      return { content: [{ type: "text", text: "Project setup cancelled." }] };
    }

    // Step 2: Advanced options
    const advancedConfig = await server.server.elicitInput({
      message: `Advanced options for your ${basicConfig.content?.language} project:`,
      requestedSchema: {
        type: "object",
        properties: {
          database: {
            type: "string",
            title: "Database",
            enum: ["postgresql", "mongodb", "sqlite", "none"],
            enumNames: ["PostgreSQL", "MongoDB", "SQLite", "None"]
          },
          testing: {
            type: "boolean",
            title: "Include Testing Setup",
            description: "Set up testing framework and sample tests"
          },
          docker: {
            type: "boolean",
            title: "Docker Support",
            description: "Add Dockerfile and docker-compose"
          }
        },
        required: ["database", "testing", "docker"]
      }
    });

    if (
      advancedConfig.action !== "accept" ||
      !advancedConfig.content ||
      !basicConfig.content
    ) {
      return { content: [{ type: "text", text: "Project setup cancelled." }] };
    }

    const basic = basicConfig.content;
    const advanced = advancedConfig.content;

    return {
      content: [
        {
          type: "text",
          text:
            `Project "${projectName}" configured:\n` +
            `• Language: ${basic.language}\n` +
            `• Framework: ${basic.framework}\n` +
            `• Database: ${advanced.database}\n` +
            `• Testing: ${advanced.testing ? "Enabled" : "Disabled"}\n` +
            `• Docker: ${advanced.docker ? "Enabled" : "Disabled"}`
        }
      ]
    };
  }
);

// Store transports for each session
const transports: Record<string, SSEServerTransport> = {};

// SSE endpoint for MCP communication
app.get("/sse", async (_req: Request, res: Response) => {
  console.log("🔗 New SSE connection established");

  const transport = new SSEServerTransport("/messages", res);
  const sessionId = transport.sessionId;
  transports[sessionId] = transport;

  // Clean up on disconnect
  res.on("close", () => {
    console.log(`🔌 SSE connection closed for session: ${sessionId}`);
    delete transports[sessionId];
  });

  try {
    await server.connect(transport);
    console.log(`✅ MCP server connected for session: ${sessionId}`);
  } catch (error) {
    console.error("❌ Error connecting MCP server:", error);
  }
});

// Message endpoint for receiving MCP messages
app.post("/messages", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports[sessionId];

  if (!transport) {
    console.error(`❌ No transport found for session: ${sessionId}`);
    return res.status(400).send("Invalid session ID");
  }

  try {
    await transport.handlePostMessage(req, res, req.body);
  } catch (error) {
    console.error("❌ Error handling message:", error);
    res.status(500).send("Internal server error");
  }
});

// Health check endpoint
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "healthy",
    server: "elicitation-test-server-http",
    version: "1.0.0",
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(PORT, () => {
  console.log(
    `🚀 MCP HTTP Elicitation Example Server running on http://localhost:${PORT}`
  );
  console.log(`📡 SSE endpoint: http://localhost:${PORT}/sse`);
  console.log(`📨 Messages endpoint: http://localhost:${PORT}/messages`);
  console.log(
    "💡 Available tools: delete-file, configure-deployment, create-user-account, setup-project"
  );
  console.log("🔧 Ready for testing!");
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
});
