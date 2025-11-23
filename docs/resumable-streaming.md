# Resumable Streaming

The Agents SDK provides a `ResumableStreamManager` for implementing AI streaming that automatically resumes after disconnections or page refreshes and streaming to several clients.

## Overview

**What it handles**

- Chunk persistence in SQLite for replay
- Stream metadata tracking (streaming, completed, error)
- Complete message history with timestamps
- Automatic detection and replay of active streams
- Multi-client support with real-time updates

## Setup

Instantiate the manager in your agent class:

```typescript
import { Agent, ResumableStreamManager } from "agents";

export class ChatAgent extends Agent<Env, State> {
  // Initialize the manager with the agent instance and context
  private streams = new ResumableStreamManager(this, this.ctx);

  // ... rest of implementation
}
```

## Required Implementation

Your agent must implement two methods:

### generateAIResponse()

This method receives options from the manager and must:

1. Generate AI response using any AI SDK
2. Call `processChunk()` for each chunk (handles saving and broadcasting)
3. Return complete content

```typescript
async generateAIResponse(options: GenerateAIResponseOptions): Promise<string> {
  // Implementation required
}
```

### \_rsm_generateResponse()

Queue callback that delegates to the manager:

```typescript
async _rsm_generateResponse(
  payload: { userMessageId: string; streamId: string },
  _queueItem?: QueueItem
) {
  await this.streams.generateResponseCallback(payload);
}
```

## Core Types

### ResumableMessage

```typescript
export type ResumableMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
};
```

### ResumableStreamChunk

```typescript
export type ResumableStreamChunk = {
  id: string;
  streamId: string;
  content: string;
  index: number;
  createdAt: number;
};
```

### ResumableStreamMetadata

```typescript
export type ResumableStreamMetadata = {
  id: string;
  messageId: string;
  status: "streaming" | "completed" | "error";
  totalChunks: number;
  createdAt: number;
  completedAt?: number;
  error?: string;
};
```

### GenerateAIResponseOptions

```typescript
export type GenerateAIResponseOptions = {
  messages: ResumableMessage[];
  streamId: string;
  messageId: string;
  processChunk: (content: string, index?: number) => Promise<void>;
};
```

### ResumableStreamState

```typescript
export interface ResumableStreamState {
  messages: ResumableMessage[];
  activeStreamId: string | null;
  [key: string]: unknown; // Extend with custom properties
}
```

### ResumableStreamAgent

```typescript
export interface ResumableStreamAgent<
  Env = unknown,
  State extends ResumableStreamState = ResumableStreamState
> extends Agent<Env, State> {
  generateAIResponse(options: GenerateAIResponseOptions): Promise<string>;
  _rsm_generateResponse(
    payload: { userMessageId: string; streamId: string },
    queueItem?: QueueItem
  ): Promise<void>;
}
```

## Core Methods

### initializeTables()

Creates SQLite tables for message and stream persistence.

```typescript
async initializeTables(): Promise<void>
```

**Tables created:**

- `messages` - conversation history
- `stream_chunks` - individual chunks for each stream
- `stream_metadata` - stream status and metadata

**Example:**

```typescript
async onStart() {
  await super.onStart();
  await this.streams.initializeTables();
}
```

### sendMessage()

Saves a user message and queues AI response generation.

```typescript
async sendMessage(content: string): Promise<{ messageId: string; streamId: string }>
```

**Parameters:**

- `content` - the user's message text

**Returns:** Message ID and stream ID

**Example:**

```typescript
const { messageId, streamId } = await this.streams.sendMessage("Hello!");
```

The method returns immediately. AI generation happens in the background via the queue system.

### loadMessages()

Loads all messages from storage.

```typescript
async loadMessages(): Promise<ResumableMessage[]>
```

**Returns:** Array of messages ordered by creation time

**Example:**

```typescript
const messages = await this.streams.loadMessages();
console.log(`Loaded ${messages.length} messages`);
```

### loadAndSyncMessages()

Loads messages from storage and syncs them to agent state.

```typescript
async loadAndSyncMessages(): Promise<void>
```

Call this during `onStart()` to restore conversation history.

**Example:**

```typescript
async onStart() {
  await super.onStart();
  await this.streams.initializeTables();
  await this.streams.loadAndSyncMessages();
}
```

### getStreamHistory()

Retrieves stream chunks and metadata for resuming.

```typescript
async getStreamHistory(streamId: string): Promise<{
  chunks: ResumableStreamChunk[];
  metadata: ResumableStreamMetadata | null;
}>
```

**Parameters:**

- `streamId` - ID of the stream to retrieve

**Returns:** Chunks array and metadata object (or null)

**Example:**

```typescript
const { chunks, metadata } = await this.streams.getStreamHistory(streamId);

if (metadata?.status === "streaming") {
  const content = chunks
    .sort((a, b) => a.index - b.index)
    .map((c) => c.content)
    .join("");
  console.log("Replaying:", content);
}
```

### clearHistory()

Removes all messages, chunks, and metadata from storage.

```typescript
async clearHistory(): Promise<void>
```

> Tip: This only clears storage. You must also reset agent state.

**Example:**

```typescript
await this.streams.clearHistory();
this.setState(this.initialState);
```

### cleanupOldStreams()

Clean up old completed stream chunks to prevent storage growth.

```typescript
async cleanupOldStreams(olderThanMs: number = 604800000): Promise<number>
```

**Parameters:**

- `olderThanMs` - Remove chunks from streams completed longer than this (in milliseconds). Defaults to 7 days.

**Returns:** Number of streams cleaned up

**Example:**

```typescript
// Clean up streams older than 7 days
await this.streams.cleanupOldStreams();
```

## How It Works

### Message flow

1. User sends message via `sendMessage()`
2. Message saved to SQLite and state updated (5-10ms)
3. `_rsm_generateResponse` queued for background processing
4. AI generation happens asynchronously
5. Each chunk saved and broadcast in real-time
6. Complete message saved when stream finishes

### Resume flow

**On reconnect:**

1. Client receives state update with `activeStreamId`
2. Calls `getStreamHistory()` to fetch chunks
3. Reconstructs streaming message from chunks

**Multi-tab support:**

- All tabs receive real-time chunks via WebSocket
- New tabs detect active stream from state
- Deduplication prevents double-replay

### Storage architecture

The manager uses a dual-layer storage pattern:

- **SQLite tables** - for queries, pagination, search
- **Agent state** - for automatic client synchronization

## Example

See [examples/resumable-stream-chat](../examples/resumable-stream-chat) for a complete implementation including agent setup, React client, and configuration.
