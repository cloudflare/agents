import { Agent, callable } from "../../index.ts";
import type { StreamingResponse } from "../../index.ts";

// Test Agent for @callable decorator tests
export class TestCallableAgent extends Agent<
  Record<string, unknown>,
  { value: number }
> {
  observability = undefined;
  initialState = { value: 0 };

  // Basic sync method
  @callable()
  add(a: number, b: number): number {
    return a + b;
  }

  // Async method
  @callable()
  async asyncMethod(delayMs: number): Promise<string> {
    await new Promise((r) => setTimeout(r, delayMs));
    return "done";
  }

  // Method that throws an error
  @callable()
  throwError(message: string): never {
    throw new Error(message);
  }

  // Void return type
  @callable()
  voidMethod(): void {
    // does nothing, returns undefined
  }

  // Returns null
  @callable()
  returnNull(): null {
    return null;
  }

  // Returns undefined
  @callable()
  returnUndefined(): undefined {
    return undefined;
  }

  // Streaming method - sync
  @callable({ streaming: true })
  streamNumbers(stream: StreamingResponse, count: number) {
    for (let i = 0; i < count; i++) {
      stream.send(i);
    }
    stream.end(count);
  }

  // Streaming method - async with delays
  @callable({ streaming: true })
  async streamWithDelay(
    stream: StreamingResponse,
    chunks: string[],
    delayMs: number
  ) {
    for (const chunk of chunks) {
      await new Promise((r) => setTimeout(r, delayMs));
      stream.send(chunk);
    }
    stream.end("complete");
  }

  // Streaming method that throws after sending a chunk
  @callable({ streaming: true })
  streamError(stream: StreamingResponse) {
    stream.send("chunk1");
    throw new Error("Stream failed");
  }

  // Streaming method that uses stream.error() to send error
  @callable({ streaming: true, description: "Sends chunk then graceful error" })
  streamGracefulError(stream: StreamingResponse) {
    stream.send("chunk1");
    stream.error("Graceful error");
  }

  // Streaming method that double-closes (error then end) - should not throw
  @callable({
    streaming: true,
    description: "Tests double-close no-op behavior"
  })
  streamDoubleClose(stream: StreamingResponse) {
    stream.send("chunk1");
    stream.error("First close");
    // These should be no-ops, not throw
    stream.end("ignored");
    stream.send("also ignored");
    stream.error("also ignored");
  }

  // Streaming method that throws before sending any response
  @callable({ streaming: true })
  streamThrowsImmediately(_stream: StreamingResponse) {
    throw new Error("Immediate failure");
  }

  // NOT decorated with @callable - should fail when called via RPC
  privateMethod(): string {
    return "secret";
  }
}

// Base class with @callable methods for testing prototype chain traversal
export class TestParentAgent extends Agent<Record<string, unknown>> {
  observability = undefined;

  @callable({ description: "Parent method from base class" })
  parentMethod(): string {
    return "from parent";
  }

  @callable()
  sharedMethod(): string {
    return "parent implementation";
  }
}

// Child agent that extends TestParentAgent - tests getCallableMethods prototype chain
export class TestChildAgent extends TestParentAgent {
  @callable({ description: "Child method from derived class" })
  childMethod(): string {
    return "from child";
  }

  // Override parent method - child version should be found first
  @callable()
  sharedMethod(): string {
    return "child implementation";
  }

  // Non-callable method for testing introspection
  nonCallableMethod(): string {
    return "not callable";
  }

  // Helper to test getCallableMethods returns parent methods
  getCallableMethodNames(): string[] {
    const methods = this.getCallableMethods();
    return Array.from(methods.keys()).sort();
  }
}
