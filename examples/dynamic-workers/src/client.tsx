import "./styles.css";
import { Suspense, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, Surface, Text, Badge, Empty } from "@cloudflare/kumo";
import {
  PlayIcon,
  ArrowCounterClockwiseIcon,
  InfoIcon,
  CodeIcon,
  TerminalIcon,
  SunIcon,
  MoonIcon
} from "@phosphor-icons/react";

function useTheme() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") || "light"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);

  const toggle = useCallback(
    () => setMode((m) => (m === "light" ? "dark" : "light")),
    []
  );

  return { mode, toggle };
}

const DEFAULT_CODE = `export default {
  fetch() {
    return new Response("Hello from a dynamic Worker!");
  },
};`;

const EXAMPLES: { label: string; code: string }[] = [
  {
    label: "Hello World",
    code: DEFAULT_CODE
  },
  {
    label: "JSON Response",
    code: `export default {
  fetch() {
    return Response.json({
      message: "Hello from a dynamic Worker!",
      timestamp: Date.now(),
    });
  },
};`
  },
  {
    label: "Headers Echo",
    code: `export default {
  fetch(request) {
    const headers = Object.fromEntries(request.headers);
    return Response.json({ headers });
  },
};`
  },
  {
    label: "Random Number",
    code: `export default {
  fetch() {
    const n = Math.floor(Math.random() * 100) + 1;
    return new Response(\`Your random number is: \${n}\`);
  },
};`
  }
];

function App() {
  const { mode, toggle: toggleTheme } = useTheme();
  const [code, setCode] = useState(DEFAULT_CODE);
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    setOutput(null);
    setError(null);

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code })
      });
      const data = await res.json<{
        ok: boolean;
        output?: string;
        status?: number;
        error?: string;
      }>();

      if (data.ok) {
        setOutput(data.output ?? "");
      } else {
        setError(data.error ?? "Unknown error");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [code]);

  const reset = useCallback(() => {
    setCode(DEFAULT_CODE);
    setOutput(null);
    setError(null);
  }, []);

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default">
              Dynamic Workers
            </h1>
            <Badge variant="secondary">
              <CodeIcon size={12} weight="bold" className="mr-1" />
              Worker Loaders
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              shape="square"
              aria-label="Toggle theme"
              onClick={toggleTheme}
              icon={
                mode === "light" ? (
                  <MoonIcon size={16} />
                ) : (
                  <SunIcon size={16} />
                )
              }
            />
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-5 py-6 space-y-5">
          <Surface className="p-4 rounded-xl ring ring-kumo-line">
            <div className="flex gap-3">
              <InfoIcon
                size={20}
                weight="bold"
                className="text-kumo-accent shrink-0 mt-0.5"
              />
              <div>
                <Text size="sm" bold>
                  Dynamic Worker Loaders
                </Text>
                <span className="mt-1 block">
                  <Text size="xs" variant="secondary">
                    Write a Worker module below and run it in a sandboxed,
                    disposable isolate. The host Worker uses{" "}
                    <code className="font-mono bg-kumo-elevated px-1 rounded">
                      LOADER.load()
                    </code>{" "}
                    to spin up a one-off dynamic Worker with no outbound network
                    access.
                  </Text>
                </span>
              </div>
            </div>
          </Surface>

          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((example) => (
              <Button
                key={example.label}
                variant="secondary"
                size="sm"
                onClick={() => {
                  setCode(example.code);
                  setOutput(null);
                  setError(null);
                }}
              >
                {example.label}
              </Button>
            ))}
          </div>

          <Surface className="rounded-xl ring ring-kumo-line overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 border-b border-kumo-line bg-kumo-base">
              <div className="flex items-center gap-2">
                <CodeIcon size={16} className="text-kumo-inactive" />
                <Text size="xs" variant="secondary" bold>
                  worker.js
                </Text>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<ArrowCounterClockwiseIcon size={14} />}
                  onClick={reset}
                >
                  Reset
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  icon={<PlayIcon size={14} weight="fill" />}
                  onClick={run}
                  loading={running}
                >
                  Run
                </Button>
              </div>
            </div>
            <textarea
              value={code}
              onChange={(e) => setCode(e.target.value)}
              spellCheck={false}
              className="w-full min-h-[200px] p-4 font-mono text-sm bg-kumo-elevated text-kumo-default resize-y outline-none"
            />
          </Surface>

          {(output !== null || error !== null) && (
            <Surface className="rounded-xl ring ring-kumo-line overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-kumo-line bg-kumo-base">
                <TerminalIcon size={16} className="text-kumo-inactive" />
                <Text size="xs" variant="secondary" bold>
                  Output
                </Text>
                {error ? (
                  <Badge variant="destructive">Error</Badge>
                ) : (
                  <Badge variant="success">Success</Badge>
                )}
              </div>
              <pre className="p-4 font-mono text-sm whitespace-pre-wrap bg-kumo-elevated text-kumo-default overflow-x-auto">
                {error ?? output}
              </pre>
            </Surface>
          )}

          {output === null && error === null && (
            <Empty
              icon={<PlayIcon size={32} />}
              title="No output yet"
              description="Write some Worker code above and click Run to execute it in a dynamic isolate."
            />
          )}
        </div>
      </div>

      <footer className="border-t border-kumo-line bg-kumo-base">
        <div className="flex justify-center py-3">
          <Text size="xs" variant="secondary">
            Powered by Dynamic Worker Loaders
          </Text>
        </div>
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen text-kumo-inactive">
          Loading...
        </div>
      }
    >
      <App />
    </Suspense>
  );
}
