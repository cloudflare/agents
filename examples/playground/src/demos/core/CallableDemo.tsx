import { useAgent } from "agents/react";
import { useState } from "react";
import { Button, Input, Surface, Text } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import {
  LogPanel,
  ConnectionStatus,
  CodeExplanation,
  HighlightedCode,
  type CodeSection
} from "../../components";
import { useLogs, useUserId, useToast } from "../../hooks";
import type { CallableAgent } from "./callable-agent";

const codeSections: CodeSection[] = [
  {
    title: "Expose methods with @callable",
    description:
      'Decorate any method with @callable() to make it available as an RPC endpoint. The decorator accepts an optional description that shows up in listMethods(). Requires "target": "ES2021" or later in your tsconfig.json. Do not enable "experimentalDecorators" — the SDK uses TC39 standard decorators, not TypeScript legacy decorators.',
    code: `import { Agent, callable } from "agents";

// tsconfig.json needs: "target": "ES2021" (or later)
// Do NOT set "experimentalDecorators": true

class CallableAgent extends Agent<Env> {
  @callable({ description: "Add two numbers" })
  add(a: number, b: number): number {
    return a + b;
  }

  @callable({ description: "Simulate an async operation" })
  async slowOperation(delayMs: number): Promise<string> {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    return \`Completed after \${delayMs}ms\`;
  }
}`
  },
  {
    title: "Call methods from the client",
    description:
      "Use agent.call() to invoke any @callable method. Arguments are passed as an array. Errors thrown on the server are re-thrown on the client.",
    code: `const agent = useAgent({
  agent: "callable-agent",
  name: "my-instance",
});

// Positional arguments passed as an array
const sum = await agent.call("add", [5, 3]);

// Async methods work the same way
const msg = await agent.call("slowOperation", [1000]);

// Errors propagate to the client
try {
  await agent.call("throwError", ["oops"]);
} catch (e) {
  console.error(e.message); // "oops"
}`
  },
  {
    title: "Self-describing APIs",
    description:
      "Agents can introspect their own callable methods at runtime using getCallableMethods(). This makes it easy to build dynamic UIs or tooling on top of agents.",
    code: `  @callable()
  listMethods() {
    return Array.from(this.getCallableMethods().entries())
      .map(([name, meta]) => ({
        name,
        description: meta.description,
      }));
  }`
  }
];

export function CallableDemo() {
  const userId = useUserId();
  const { logs, addLog, clearLogs } = useLogs();
  const { toast } = useToast();
  const [methods, setMethods] = useState<
    Array<{ name: string; description?: string }>
  >([]);
  const [argA, setArgA] = useState("5");
  const [argB, setArgB] = useState("3");
  const [echoMessage, setEchoMessage] = useState("Hello, Agent!");
  const [delayMs, setDelayMs] = useState("1000");
  const [errorMessage, setErrorMessage] = useState("Test error");
  const [lastResult, setLastResult] = useState<string | null>(null);

  const agent = useAgent<CallableAgent, {}>({
    agent: "callable-agent",
    name: `callable-demo-${userId}`,
    onOpen: () => addLog("info", "connected"),
    onClose: () => addLog("info", "disconnected"),
    onError: () => addLog("error", "error", "Connection error")
  });

  const handleCall = async (method: string, args: unknown[]) => {
    addLog("out", "call", { method, args });
    setLastResult(null);
    try {
      const result = await (
        agent.call as (m: string, a?: unknown[]) => Promise<unknown>
      )(method, args);
      addLog("in", "result", result);
      setLastResult(JSON.stringify(result, null, 2));
      toast(method + "() → " + JSON.stringify(result).slice(0, 60), "success");
      return result;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      addLog("error", "error", error);
      setLastResult(`Error: ${error}`);
      toast(error, "error");
      throw e;
    }
  };

  const handleListMethods = async () => {
    try {
      const result = (await handleCall("listMethods", [])) as Array<{
        name: string;
        description?: string;
      }>;
      setMethods(result);
    } catch {
      // Error already logged
    }
  };

  return (
    <DemoWrapper
      title="Callable Methods"
      description={
        <>
          Decorate any method with{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            @callable()
          </code>{" "}
          to expose it as an RPC endpoint. Clients call these methods using{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            agent.call()
          </code>{" "}
          over WebSocket — arguments are serialized, errors propagate, and async
          methods just work. Methods can optionally include a description for
          self-documenting APIs.
        </>
      }
      statusIndicator={
        <ConnectionStatus
          status={
            agent.readyState === WebSocket.OPEN ? "connected" : "connecting"
          }
        />
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Controls */}
        <div className="space-y-6">
          {/* Math Operations */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Math Operations</Text>
            </div>
            <div className="flex gap-2 mb-3">
              <Input
                aria-label="Argument A"
                type="number"
                value={argA}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setArgA(e.target.value)
                }
                className="w-20"
              />
              <Input
                aria-label="Argument B"
                type="number"
                value={argB}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setArgB(e.target.value)
                }
                className="w-20"
              />
            </div>
            <div className="flex gap-2">
              <Button
                variant="primary"
                onClick={() => handleCall("add", [Number(argA), Number(argB)])}
              >
                add({argA}, {argB})
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  handleCall("multiply", [Number(argA), Number(argB)])
                }
              >
                multiply({argA}, {argB})
              </Button>
            </div>
          </Surface>

          {/* Echo */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Echo</Text>
            </div>
            <div className="flex gap-2">
              <Input
                aria-label="Echo message"
                type="text"
                value={echoMessage}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setEchoMessage(e.target.value)
                }
                className="flex-1"
              />
              <Button
                variant="primary"
                onClick={() => handleCall("echo", [echoMessage])}
              >
                Echo
              </Button>
            </div>
          </Surface>

          {/* Async Operation */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Async Operation</Text>
            </div>
            <div className="flex gap-2">
              <Input
                aria-label="Delay in milliseconds"
                type="number"
                value={delayMs}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setDelayMs(e.target.value)
                }
                className="w-24"
                placeholder="ms"
              />
              <Button
                variant="primary"
                onClick={() => handleCall("slowOperation", [Number(delayMs)])}
              >
                slowOperation({delayMs})
              </Button>
            </div>
            <p className="text-xs text-kumo-subtle mt-2">
              Simulates a slow operation with configurable delay
            </p>
          </Surface>

          {/* Error Handling */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Error Handling</Text>
            </div>
            <div className="flex gap-2">
              <Input
                aria-label="Error message"
                type="text"
                value={errorMessage}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setErrorMessage(e.target.value)
                }
                className="flex-1"
              />
              <Button
                variant="destructive"
                onClick={() =>
                  handleCall("throwError", [errorMessage]).catch(() => {})
                }
              >
                Throw Error
              </Button>
            </div>
          </Surface>

          {/* Utility */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Utility Methods</Text>
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button
                variant="secondary"
                onClick={() => handleCall("getTimestamp", [])}
              >
                getTimestamp()
              </Button>
              <Button variant="secondary" onClick={handleListMethods}>
                listMethods()
              </Button>
            </div>
          </Surface>

          {/* Available Methods */}
          {methods.length > 0 && (
            <Surface className="p-4 rounded-lg ring ring-kumo-line">
              <div className="mb-4">
                <Text variant="heading3">Available Methods</Text>
              </div>
              <div className="space-y-1 text-sm">
                {methods.map((m) => (
                  <div
                    key={m.name}
                    className="flex justify-between py-1 border-b border-kumo-fill last:border-0"
                  >
                    <code className="font-mono text-kumo-default">
                      {m.name}
                    </code>
                    {m.description && (
                      <span className="text-kumo-subtle text-xs">
                        {m.description}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </Surface>
          )}

          {/* Last Result */}
          {lastResult && (
            <Surface className="p-4 rounded-lg ring ring-kumo-line">
              <div className="mb-2">
                <Text variant="heading3">Last Result</Text>
              </div>
              <HighlightedCode
                code={lastResult}
                lang={lastResult.startsWith("Error:") ? "typescript" : "json"}
              />
            </Surface>
          )}
        </div>

        {/* Logs */}
        <div className="space-y-6">
          <LogPanel logs={logs} onClear={clearLogs} maxHeight="400px" />
        </div>
      </div>

      <CodeExplanation sections={codeSections} />
    </DemoWrapper>
  );
}
