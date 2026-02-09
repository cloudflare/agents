# Agent Patterns Demo

This project demonstrates different patterns for building AI agents, based on [Anthropic's research](https://www.anthropic.com/research/building-effective-agents), implemented using Cloudflare's Durable Objects and the [AI SDK](https://sdk.vercel.ai/).

<img width="893" alt="image" src="https://github.com/user-attachments/assets/160fe1aa-782d-4619-94b4-55f009105f37" />

## Overview

The demo showcases five fundamental patterns for building AI agents:

1. **Prompt Chaining**: Sequential processing where each step builds on the previous
2. **Routing**: Intelligent classification and routing of tasks
3. **Parallelization**: Concurrent execution of multiple subtasks
4. **Orchestrator-Workers**: Dynamic task breakdown and delegation
5. **Evaluator-Optimizer**: Iterative improvement through feedback loops

Each pattern is implemented as a Durable Object, providing persistence, real-time updates, and scalability.

## Architecture

### Frontend

- React application with TypeScript
- Real-time WebSocket connections to Durable Objects (powered by PartySocket, a reconnecting websocket library with a react hook)
- Dark mode support
- Responsive design

### Backend

- Cloudflare Durable Objects + PartyServer for agent state management
- WebSocket connections for live updates
- OpenAI integration via AI SDK
- AI SDK for defining agent workflows
- [AI Gateway](https://developers.cloudflare.com/ai-gateway/) for caching and rate limiting

## Features

- **Live Agent Interaction**: Test each pattern with real inputs
- **Real-time Updates**: See agent progress as it happens
- **Persistent State**: Agents continue running even if you close the browser
- **Global Scaling**: Runs on Cloudflare's edge network
- **Bonus: Dark Mode**: Supports system preferences and manual toggle

## Getting Started

1. Clone the repository
2. Install dependencies:

   ```bash
   npm install
   ```

3. Create a `.dev.vars` file with your API keys:

   ```
   OPENAI_API_KEY=your_key_here
   AI_GATEWAY_TOKEN=your_key_here
   ```

4. Edit `wrangler.json` to set your account ID and ai gateway ID details:

   ```json
   "account_id": "your_account_id_here"
   "vars": {
     "AI_GATEWAY_ACCOUNT_ID": "your_account_id_here",
     "AI_GATEWAY_ID": "your_gateway_id_here"
   }
   ```

5. Run the development server:
   ```bash
   npm start
   ```

## Deployment

The application is designed to be deployed to Cloudflare Workers:

```bash
npm run deploy
```

## Implementation Details

### Durable Objects

We have an `createAgent` factory function that creates a new Durable Object class for a given pattern/workflow. The template for the class includes basic state management and websocket communication. So by calling `createAgent(async () => {/* run the pattern */})` we get a new Durable Object class that can be used to create an instance. We create the 5 types of agents and export them from the worker, and wire them up as bindings in `wrangler.jsonc`.

### WebSocket Communication

The frontend maintains WebSocket connections to each Durable Object instance. The websocket sends state updates to the frontend.

```typescript
const socket = usePartySocket({
  party: type,
  room: "default-room",
  onMessage: (e) => {
    const data = JSON.parse(e.data);
    switch (data.type) {
      case "state":
        setWorkflowState(data.state);
        break;
    }
  }
});
```

The frontend also triggers the workflow by sending a `run` message to the websocket with initial input.

### State Management

Each Durable Object maintains its own state:

```typescript
state: {
  isRunning: boolean;
  output: any;
} = {
  isRunning: false,
  output: undefined,
};
```

Read more in the [source code](src/server.tsx).

## Why Durable Objects?

Durable Objects provide several key benefits for hosting AI agents:

1. **Persistence**: Agents continue running even when clients disconnect
2. **Real-time Updates**: WebSocket connections enable live progress streaming
3. **Global Scale**: Automatic distribution across Cloudflare's network
4. **Flexible Triggers**: Can be activated by HTTP, cron jobs, or other events
5. **Memory Isolation**: Each agent runs in its own environment
6. **Cost Effective**: Pay only for actual compute time used

## Contributing

Contributions are welcome! Please read our contributing guidelines and submit pull requests.

## License

MIT License - feel free to use this code in your own projects.

## Acknowledgments

- Based on research by [Anthropic](https://www.anthropic.com/research/building-effective-agents)
- Uses [AI SDK](https://sdk.vercel.ai/docs/foundations/agents)
- Built on [Cloudflare Workers](https://workers.cloudflare.com/) and [Durable Objects](https://developers.cloudflare.com/workers/learning/using-durable-objects)
