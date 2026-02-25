# Session Memory Example

Demonstrates using the experimental `AgentSessionProvider` for conversation history storage with automatic compaction.

## Features

- **Session Memory**: Store AI SDK compatible messages in the Agent's SQLite storage
- **Compaction**: Summarize older messages using Workers AI to reduce context size
- **Sliding Window Strategy**: Keep recent messages, summarize older ones

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Run locally:
   ```bash
   npm start
   ```

## Usage

### Send a message

```bash
curl -X POST http://localhost:8787/agents/chat-agent/my-session/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello! What can you help me with?"}'
```

### Get all messages

```bash
curl http://localhost:8787/agents/chat-agent/my-session/messages
```

### Trigger compaction

After many messages, compact the session to reduce context size:

```bash
curl -X POST http://localhost:8787/agents/chat-agent/my-session/compact
```

### Clear session

```bash
curl -X DELETE http://localhost:8787/agents/chat-agent/my-session/messages
```

## How Compaction Works

The `sliding_window` strategy:

1. **Before compaction** (10 messages):

   ```
   [msg1, msg2, msg3, msg4, msg5, msg6, msg7, msg8, msg9, msg10]
   ```

2. **After compaction** (keepRatio: 0.3):
   ```
   [summary of msg1-7] + [msg8, msg9, msg10]
   ```

The summary is generated using Workers AI (Llama 3.1 8B).
