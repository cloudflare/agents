# Queue System

The Agents SDK provides a built-in queue system that allows you to schedule tasks for asynchronous execution. This is particularly useful for background processing, delayed operations, and managing workloads that don't need immediate execution.

## Overview

The queue system is built into the base `Agent` class. Tasks are stored in a SQLite table and processed automatically in FIFO (First In, First Out) order.

## QueueItem Type

```typescript
export type QueueItem<T = string> = {
  id: string; // Unique identifier for the queued task
  payload: T; // Data to pass to the callback function
  callback: keyof Agent<unknown>; // Name of the method to call
  created_at: number; // Timestamp when the task was created
};
```

## Core Methods

### queue()

Adds a task to the queue for future execution.

```typescript
async queue<T = unknown>(callback: keyof this, payload: T): Promise<string>
```

**Parameters:**

- `callback`: The name of the method to call when processing the task
- `payload`: Data to pass to the callback method

**Returns:** The unique ID of the queued task

**Example:**

```typescript
class MyAgent extends Agent {
  async processEmail(data: { email: string; subject: string }) {
    // Process the email
    console.log(`Processing email: ${data.subject}`);
  }

  async onMessage(message: string) {
    // Queue an email processing task
    const taskId = await this.queue("processEmail", {
      email: "user@example.com",
      subject: "Welcome!"
    });

    console.log(`Queued task with ID: ${taskId}`);
  }
}
```

### dequeue()

Removes a specific task from the queue by ID.

```typescript
async dequeue(id: string): Promise<void>
```

**Parameters:**

- `id`: The ID of the task to remove

**Example:**

```typescript
// Remove a specific task
await agent.dequeue("abc123def");
```

### dequeueAll()

Removes all tasks from the queue.

```typescript
async dequeueAll(): Promise<void>
```

**Example:**

```typescript
// Clear the entire queue
await agent.dequeueAll();
```

### dequeueAllByCallback()

Removes all tasks that match a specific callback method.

```typescript
async dequeueAllByCallback(callback: string): Promise<void>
```

**Parameters:**

- `callback`: Name of the callback method

**Example:**

```typescript
// Remove all email processing tasks
await agent.dequeueAllByCallback("processEmail");
```

### getQueue()

Retrieves a specific queued task by ID.

```typescript
async getQueue(id: string): Promise<QueueItem<string> | undefined>
```

**Parameters:**

- `id`: The ID of the task to retrieve

**Returns:** The QueueItem with parsed payload or undefined if not found

**Note:** The payload is automatically parsed from JSON before being returned

**Example:**

```typescript
const task = await agent.getQueue("abc123def");
if (task) {
  console.log(`Task callback: ${task.callback}`);
  console.log(`Task payload:`, task.payload);
}
```

### getQueues()

Retrieves all queued tasks that match a specific key-value pair in their payload.

```typescript
async getQueues(key: string, value: string): Promise<QueueItem<string>[]>
```

**Parameters:**

- `key`: The key to filter by in the payload
- `value`: The value to match

**Returns:** Array of matching QueueItem objects

**Note:** This method fetches all queue items and filters them in memory by parsing each payload and checking if the specified key matches the value

**Example:**

```typescript
// Find all tasks for a specific user
const userTasks = await agent.getQueues("userId", "12345");
```

## How Queue Processing Works

1. **Validation**: When calling `queue()`, the method validates that the callback exists as a function on the agent
2. **Automatic Processing**: After queuing, the system automatically attempts to flush the queue
3. **FIFO Order**: Tasks are processed in the order they were created (`created_at` timestamp)
4. **Context Preservation**: Each queued task runs with the same agent context (connection, request, email)
5. **Automatic Dequeue**: Successfully executed tasks are automatically removed from the queue
6. **Error Handling**: If a callback method doesn't exist at execution time, an error is logged and the task is skipped
7. **Persistence**: Tasks are stored in the `cf_agents_queues` D1 table and survive agent restarts

## Queue Callback Methods

When defining callback methods for queued tasks, they must follow this signature:

```typescript
async callbackMethod(payload: unknown, queueItem: QueueItem<string>): Promise<void>
```

**Example:**

```typescript
class MyAgent extends Agent {
  async sendNotification(
    payload: { userId: string; message: string },
    queueItem: QueueItem<string>
  ) {
    console.log(`Processing task ${queueItem.id}`);
    console.log(
      `Sending notification to user ${payload.userId}: ${payload.message}`
    );

    // Your notification logic here
    await this.notificationService.send(payload.userId, payload.message);
  }

  async onUserSignup(userData: any) {
    // Queue a welcome notification
    await this.queue("sendNotification", {
      userId: userData.id,
      message: "Welcome to our platform!"
    });
  }
}
```

## Use Cases

### Background Processing

```typescript
class DataProcessor extends Agent {
  async processLargeDataset(data: { datasetId: string; userId: string }) {
    const results = await this.heavyComputation(data.datasetId);
    await this.notifyUser(data.userId, results);
  }

  async onDataUpload(uploadData: any) {
    // Queue the processing instead of doing it synchronously
    await this.queue("processLargeDataset", {
      datasetId: uploadData.id,
      userId: uploadData.userId
    });

    return { message: "Data upload received, processing started" };
  }
}
```

### Delayed Operations

```typescript
class ReminderAgent extends Agent {
  async sendReminder(data: { userId: string; message: string }) {
    await this.emailService.send(data.userId, data.message);
  }

  async scheduleReminder(userId: string, message: string, delayMs: number) {
    // Note: For true delayed execution, combine with the scheduling system
    // This example shows queueing for later processing
    await this.queue("sendReminder", { userId, message });
  }
}
```

### Batch Operations

```typescript
class BatchProcessor extends Agent {
  async processBatch(data: { items: any[]; batchId: string }) {
    for (const item of data.items) {
      await this.processItem(item);
    }
    console.log(`Completed batch ${data.batchId}`);
  }

  async onLargeRequest(items: any[]) {
    // Split large requests into smaller batches
    const batchSize = 10;
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      await this.queue("processBatch", {
        items: batch,
        batchId: `batch-${i / batchSize + 1}`
      });
    }
  }
}
```

## Best Practices

1. **Keep Payloads Small**: Payloads are JSON-serialized and stored in the database
2. **Idempotent Operations**: Design callback methods to be safe to retry
3. **Error Handling**: Include proper error handling in callback methods
4. **Monitoring**: Use logging to track queue processing
5. **Cleanup**: Regularly clean up completed or failed tasks if needed

## Error Handling

```typescript
class RobustAgent extends Agent {
  async reliableTask(payload: any, queueItem: QueueItem<string>) {
    try {
      await this.doSomethingRisky(payload);
    } catch (error) {
      console.error(`Task ${queueItem.id} failed:`, error);

      // Optionally re-queue with retry logic
      if (payload.retryCount < 3) {
        await this.queue("reliableTask", {
          ...payload,
          retryCount: (payload.retryCount || 0) + 1
        });
      }
    }
  }
}
```

## Integration with Other Features

The queue system works seamlessly with other Agent SDK features:

- **State Management**: Access agent state within queued callbacks
- **Scheduling**: Combine with `schedule()` for time-based queue processing
- **Context**: Queued tasks maintain the original request context
- **Database**: Uses the same database as other agent data

## Limitations

- Tasks are processed sequentially, not in parallel
- No built-in retry mechanism (implement your own)
- No priority system (FIFO only)
- Queue processing happens during agent execution, not as separate background jobs
