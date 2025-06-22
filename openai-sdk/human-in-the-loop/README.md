# Human-in-the-Loop Weather Agent

This example demonstrates a web-based human-in-the-loop interface for OpenAI Agents, where certain tool calls require human approval before execution.

## Features

- **Interactive Chat Interface**: Modern web UI for conversing with the weather agent
- **Human-in-the-Loop Approval**: Automatic approval requests for sensitive operations
- **Real-time Updates**: WebSocket communication for live agent responses
- **State Persistence**: Conversation history and approval state management
- **Responsive Design**: Works on desktop and mobile devices

## How It Works

The agent is configured with a weather lookup tool that requires approval for queries about San Francisco. Here's the workflow:

1. **User asks a question** asking about weather in different cities
2. **Agent processes the request** and identifies which tool calls need approval
3. **Approval modal appears** when San Francisco weather is requested
4. **User approves or rejects** the tool call and the agent continues execution
5. **Agent continues execution** and provides the final result

## Getting Started

### Prerequisites

- Node.js 18+
- Cloudflare account with Workers enabled
- OpenAI API key

### Setup

1. **Install dependencies**:

   ```bash
   npm install
   ```

2. **Configure environment variables**:

   ```bash
   cp .dev.vars.example .dev.vars
   ```

   Edit `.dev.vars` and add your OpenAI API key:

   ```
   OPENAI_API_KEY=your_openai_api_key_here
   ```

3. **Start the development server**:

   ```bash
   npm start
   ```

4. **Open your browser** and navigate to `http://localhost:5173`

## Usage

1. **Ask about weather**: Type questions like "What's the weather in Oakland and San Francisco?"
2. **Handle approvals**: When the modal appears, review the tool call details and approve/reject
3. **View results**: See the agent's final response after all approvals are handled

## Example Conversations

- "What's the weather in New York?" (No approval needed)
- "What's the weather in San Francisco?" (Approval required)
- "Compare weather in Oakland and San Francisco" (Approval required for SF)

## Technical Details

### Architecture

- **Frontend**: React with TypeScript and Tailwind CSS
- **Backend**: Cloudflare Workers with Durable Objects
- **Communication**: WebSocket for real-time updates
- **State Management**: Agent state serialization/deserialization

### Key Components

- **Agent Configuration**: Weather tool with approval logic
- **WebSocket Handler**: Real-time message passing
- **Approval Workflow**: Modal interface for tool call approval
- **State Persistence**: Database storage for conversation history

### Customization

To modify the approval logic, edit the `needsApproval` function in `src/server.ts`:

```typescript
needsApproval: async (_context, { location }) => {
  // Customize approval conditions here
  return location === "San Francisco";
},
```

## Troubleshooting

- **WebSocket connection issues**: Check that the development server is running
- **Approval not working**: Verify the agent state is properly managed
- **No responses**: Ensure your OpenAI API key is correctly configured

## Learn More

- [OpenAI Agents Documentation](https://openai.github.io/openai-agents-js/)
- [Human-in-the-Loop Guide](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
