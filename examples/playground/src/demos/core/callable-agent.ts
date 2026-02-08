import { Agent, callable } from "agents";

export class CallableAgent extends Agent<Env, {}> {
  @callable({ description: "Add two numbers" })
  add(a: number, b: number): number {
    return a + b;
  }

  @callable({ description: "Multiply two numbers" })
  multiply(a: number, b: number): number {
    return a * b;
  }

  @callable({ description: "Echo a message" })
  echo(message: string): string {
    return `Echo: ${message}`;
  }

  @callable({ description: "Get current timestamp" })
  getTimestamp(): string {
    return new Date().toISOString();
  }

  @callable({ description: "Simulate an async operation" })
  async slowOperation(delayMs: number): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return `Completed after ${delayMs}ms`;
  }

  @callable({ description: "Intentionally throws an error" })
  throwError(message: string): never {
    throw new Error(message);
  }

  @callable({ description: "List all callable methods" })
  listMethods(): Array<{ name: string; description?: string }> {
    return Array.from(this.getCallableMethods().entries()).map(
      ([name, meta]) => ({
        name,
        description: meta.description
      })
    );
  }
}
