import {
  Think,
  callable,
  hostAgent,
  type StreamingResponse
} from "../compat.js";

type ErrorCapableStream = StreamingResponse & {
  error(error: string): void;
};

class TestP12CallableAgentImpl extends Think<{ value: number }> {
  protected override getInitialState(): { value: number } {
    return { value: 0 };
  }

  @callable()
  add(a: number, b: number): number {
    return a + b;
  }

  @callable()
  async asyncMethod(delayMs: number): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return "done";
  }

  @callable()
  async delayedThrow(delayMs: number): Promise<never> {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    throw new Error("delayed failure");
  }

  @callable()
  throwError(message: string): never {
    throw new Error(message);
  }

  @callable()
  voidMethod(): void {}

  @callable()
  returnNull(): null {
    return null;
  }

  @callable()
  returnUndefined(): undefined {
    return undefined;
  }

  @callable({ streaming: true })
  streamNumbers(stream: StreamingResponse, count: number): void {
    for (let i = 0; i < count; i++) {
      stream.send(i);
    }
    stream.end(count);
  }

  @callable({ streaming: true })
  async streamWithDelay(
    stream: StreamingResponse,
    chunks: string[],
    delayMs: number
  ): Promise<void> {
    for (const chunk of chunks) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      stream.send(chunk);
    }
    stream.end("complete");
  }

  @callable({ streaming: true })
  streamError(stream: StreamingResponse): void {
    stream.send("chunk1");
    throw new Error("Stream failed");
  }

  @callable({ streaming: true, description: "Sends chunk then graceful error" })
  streamGracefulError(stream: StreamingResponse): void {
    const errorStream = stream as ErrorCapableStream;
    errorStream.send("chunk1");
    errorStream.error("Graceful error");
  }

  @callable({
    streaming: true,
    description: "Tests double-close no-op behavior"
  })
  streamDoubleClose(stream: StreamingResponse): void {
    const errorStream = stream as ErrorCapableStream;
    errorStream.send("chunk1");
    errorStream.error("First close");
    errorStream.end("ignored");
    errorStream.send("also ignored");
    errorStream.error("also ignored");
  }

  @callable({ streaming: true })
  streamThrowsImmediately(_stream: StreamingResponse): never {
    throw new Error("Immediate failure");
  }

  privateMethod(): string {
    return "secret";
  }
}

class TestP12ParentAgentImpl extends Think {
  @callable({ description: "Parent method from base class" })
  parentMethod(): string {
    return "from parent";
  }

  @callable()
  sharedMethod(): string {
    return "parent implementation";
  }
}

class TestP12ChildAgentImpl extends TestP12ParentAgentImpl {
  @callable({ description: "Child method from derived class" })
  childMethod(): string {
    return "from child";
  }

  @callable()
  override sharedMethod(): string {
    return "child implementation";
  }

  nonCallableMethod(): string {
    return "not callable";
  }

  getCallableMethodNames(): string[] {
    return Array.from(this.callableMethods().keys()).sort();
  }
}

const TestP12CallableAgentBase = hostAgent(TestP12CallableAgentImpl);
const TestP12ChildAgentBase = hostAgent(TestP12ChildAgentImpl);

export class TestP12CallableAgent extends TestP12CallableAgentBase {}

export class TestP12ChildAgent extends TestP12ChildAgentBase {
  getCallableMethodNames(): Promise<string[]> {
    return this.withAgent((agent) => agent.getCallableMethodNames());
  }
}
