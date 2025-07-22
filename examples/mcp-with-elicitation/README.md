# MCP Elicitation Example

A demonstration of MCP elicitation support, enabling interactive user input during tool execution.

## Overview

This example shows how to create MCP tools that can request user input through interactive dialogs - perfect for confirmations, form data, and multi-step workflows.

## Prerequisites

- **VS Code** with MCP support
- **Node.js** 18+

## Quick Setup

1. **Install dependencies:**

   ```bash
   npm install
   ```

2. **Start the server:**

   ```bash
   npm start
   ```

3. **Configure your MCP client:**

   **For mcp.json (HTTP/SSE clients):**

   ```json
   {
     "servers": {
       "elicitation-example": {
         "url": "http://localhost:3001/sse",
         "type": "sse"
       }
     },
     "inputs": []
   }
   ```

   **For VS Code (stdio servers):**
   Create a stdio version and add to `settings.json`:

   ```json
   {
     "mcp": {
       "mcpServers": {
         "elicitation-example": {
           "command": "tsx",
           "args": ["/absolute/path/to/server.ts"]
         }
       }
     }
   }
   ```

4. **Restart your MCP client**

## VS Code MCP Debugging

If using VS Code with MCP:

1. **View MCP servers**: Press `Shift + Cmd + P` (Mac) or `Shift + Ctrl + P` (Windows/Linux)
2. **Type "MCP"** to see available commands:

## Test the Examples

Try these prompts to test elicitation features:

### Simple Confirmation

- "Delete the file 'test.txt'"
- Should show: confirmation checkbox

### Multiple Choice Form

- "Configure deployment for MyApp"
- Should show: dropdowns for environment, region, auto-scaling toggle

### Complex Form with Validation

- "Create user account for 'alice'"
- Should show: email field (with validation), name field, role dropdown, welcome email checkbox

### Multi-Step Workflow

- "Setup project called 'my-web-app'"
- Should show: Step 1 (language/framework), then Step 2 (database/testing/docker options)

## Implementation Examples

**Basic Confirmation:**

```typescript
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
```

**Multi-Choice Selection:**

```typescript
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
```
