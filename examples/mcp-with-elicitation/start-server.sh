#!/bin/bash

# Start the MCP Elicitation Example Server
echo "🚀 Starting MCP Elicitation Example Server..."

# Kill any existing server on port 3001
pkill -f "tsx server.ts" 2>/dev/null || true

# Start the server
npm start

echo "🔌 Server stopped."