import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@cloudflare/agents-ui/hooks";
import {
  ConnectionIndicator,
  ModeToggle,
  PoweredByAgents,
  type ConnectionStatus
} from "@cloudflare/agents-ui";
import { Button, Badge, Surface, Text, Empty } from "@cloudflare/kumo";
import {
  CurrencyDollarIcon,
  ShieldCheckIcon,
  PaperPlaneRightIcon,
  TrashIcon,
  InfoIcon,
  WarningCircleIcon,
  CheckCircleIcon
} from "@phosphor-icons/react";
import { useAgent } from "agents/react";
import { nanoid } from "nanoid";
import "./styles.css";

let sessionId = localStorage.getItem("x402-session");
if (!sessionId) {
  sessionId = nanoid(8);
  localStorage.setItem("x402-session", sessionId);
}

interface FetchResult {
  text: string;
  isError: boolean;
  timestamp: number;
}

function App() {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [results, setResults] = useState<FetchResult[]>([]);
  const [loading, setLoading] = useState(false);

  const agent = useAgent({
    agent: "pay-agent",
    name: sessionId!,
    onOpen: useCallback(() => setStatus("connected"), []),
    onClose: useCallback(() => setStatus("disconnected"), [])
  });

  const handleFetch = async () => {
    setLoading(true);
    try {
      const res = (await agent.call("fetchProtectedRoute", [])) as {
        text: string;
        isError: boolean;
      };
      setResults((prev) => [
        { text: res.text, isError: res.isError, timestamp: Date.now() },
        ...prev
      ]);
    } catch (err) {
      setResults((prev) => [
        {
          text: err instanceof Error ? err.message : String(err),
          isError: true,
          timestamp: Date.now()
        },
        ...prev
      ]);
    }
    setLoading(false);
  };

  return (
    <div className="h-full flex flex-col bg-kumo-base">
      <header className="px-5 py-4 border-b border-kumo-line">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <CurrencyDollarIcon
              size={22}
              className="text-kumo-accent"
              weight="bold"
            />
            <h1 className="text-lg font-semibold text-kumo-default">
              x402 Payments
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={status} />
            <ModeToggle />
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto p-5">
        <div className="max-w-2xl mx-auto space-y-6">
          <Surface className="p-4 rounded-xl ring ring-kumo-line">
            <div className="flex gap-3">
              <InfoIcon
                size={20}
                weight="bold"
                className="text-kumo-accent shrink-0 mt-0.5"
              />
              <div>
                <Text size="sm" bold>
                  HTTP Payment Gating (x402)
                </Text>
                <span className="mt-1 block">
                  <Text size="xs" variant="secondary">
                    This demo uses the{" "}
                    <code className="text-xs px-1 py-0.5 rounded bg-kumo-elevated font-mono">
                      @x402/*
                    </code>{" "}
                    libraries to gate an HTTP endpoint behind a $0.10 paywall.
                    An Agent with a test wallet pays automatically using{" "}
                    <code className="text-xs px-1 py-0.5 rounded bg-kumo-elevated font-mono">
                      wrapFetchWithPayment
                    </code>
                    . The server uses Hono middleware to verify payments.
                  </Text>
                </span>
              </div>
            </div>
          </Surface>

          {status === "disconnected" && (
            <Empty
              icon={<CurrencyDollarIcon size={32} />}
              title="Disconnected"
              description="Could not connect to the agent. Make sure the server is running."
            />
          )}

          {status === "connected" && (
            <>
              <Surface className="p-5 rounded-xl ring ring-kumo-line">
                <div className="flex items-center gap-2 mb-3">
                  <ShieldCheckIcon
                    size={18}
                    weight="bold"
                    className="text-kumo-subtle"
                  />
                  <Text size="sm" bold>
                    Protected Route
                  </Text>
                  <Badge variant="secondary">$0.10</Badge>
                </div>
                <span className="block mb-4">
                  <Text size="xs" variant="secondary">
                    The agent will fetch{" "}
                    <code className="text-xs px-1 py-0.5 rounded bg-kumo-elevated font-mono">
                      /protected-route
                    </code>{" "}
                    and automatically sign a $0.10 payment on Base Sepolia using
                    its configured wallet.
                  </Text>
                </span>
                <Button
                  variant="primary"
                  size="sm"
                  loading={loading}
                  icon={<PaperPlaneRightIcon size={14} />}
                  onClick={handleFetch}
                >
                  Fetch & Pay
                </Button>
              </Surface>

              {results.length > 0 && (
                <section>
                  <div className="flex items-center justify-between mb-3">
                    <Text size="base" bold>
                      Results
                    </Text>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<TrashIcon size={14} />}
                      onClick={() => setResults([])}
                    >
                      Clear
                    </Button>
                  </div>
                  <div className="space-y-2">
                    {results.map((r) => (
                      <Surface
                        key={r.timestamp}
                        className={`p-3 rounded-xl ring ${r.isError ? "ring-red-500/30 bg-red-50 dark:bg-red-950/20" : "ring-kumo-line"}`}
                      >
                        <div className="flex items-start gap-2">
                          {r.isError ? (
                            <WarningCircleIcon
                              size={16}
                              weight="fill"
                              className="text-red-500 shrink-0 mt-0.5"
                            />
                          ) : (
                            <CheckCircleIcon
                              size={16}
                              weight="fill"
                              className="text-green-600 shrink-0 mt-0.5"
                            />
                          )}
                          <pre
                            className={`text-sm flex-1 whitespace-pre-wrap break-words font-mono ${r.isError ? "text-red-600 dark:text-red-400" : "text-kumo-default"}`}
                          >
                            {r.text}
                          </pre>
                          <span className="text-[10px] text-kumo-inactive tabular-nums shrink-0">
                            {new Date(r.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                      </Surface>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </main>

      <footer className="border-t border-kumo-line py-3">
        <div className="flex justify-center">
          <PoweredByAgents />
        </div>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>
);
