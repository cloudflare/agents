# LLM as a Judge

This example demonstrates a web-based LLM as a judge interface for OpenAI Agents.

## Features

- **Interactive Chat Interface**: Modern web UI for conversing with the weather agent
- **Real-time Updates**: WebSocket communication for live agent responses
- **State Persistence**: Conversation history and approval state management
- **Responsive Design**: Works on desktop and mobile devices

## How It Works

The agent is configured to generate a slogan and then receive feedback on the slogan, until it's is deemed worthy. Here's the workflow:

1. **User provides a description of a product**
2. **Agent processes the request** and generates a new slogan
3. **Evaluator Agent** judges the slogan and provides feedback
4. **Agent retries** up until 15 times.

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

1. **Generate a new slogan**: Describe your product like "A taco cart that has very spicy hot sauce"
2. **View results**: As the agent generates slogan, you can see the LLM judge and provide feedback.

## Technical Details

### Architecture

- **Frontend**: React with TypeScript and Tailwind CSS
- **Backend**: Cloudflare Workers with Agent Framework
- **Communication**: WebSocket for real-time updates
- **State Management**: Agent state serialization/deserialization

### Key Components

- **Agent Configuration**: Two OpenAI SDK agents, Marketer and Evaluatior
- **WebSocket Handler**: Real-time message passing
- **State Persistence**: State storage for generation history

## Troubleshooting

- **WebSocket connection issues**: Check that the development server is running
- **No responses**: Ensure your OpenAI API key is correctly configured

## Learn More

- [OpenAI Agents Documentation](https://openai.github.io/openai-agents-js/)
- [LLM As a Judge Guide](https://github.com/openai/openai-agents-js/blob/main/examples/agent-patterns/llm-as-a-judge.ts)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
