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
  MegaphoneIcon,
  HashIcon,
  PaperPlaneRightIcon,
  TrashIcon,
  XIcon,
  CheckIcon,
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

interface ToolResult {
  label: string;
  text: string;
  isError: boolean;
  timestamp: number;
}

interface PaymentInfo {
  resource: string;
  address: string;
  network: string;
  amount: string;
  id: string;
}

function App() {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [results, setResults] = useState<ToolResult[]>([]);
  const [payment, setPayment] = useState<PaymentInfo | null>(null);

  const agent = useAgent({
    agent: "pay-agent",
    name: sessionId!,
    onOpen: useCallback(() => setStatus("connected"), []),
    onClose: useCallback(() => setStatus("disconnected"), []),
    onMessage: useCallback((message: MessageEvent) => {
      try {
        const parsed = JSON.parse(message.data);
        if (
          parsed.type === "payment_required" &&
          Array.isArray(parsed.requirements)
        ) {
          const p = parsed.requirements[0] || {};
          const amt = (Number(p.maxAmountRequired) / 1e6).toString();
          setPayment({
            resource: p.resource || "—",
            address: p.payTo || "—",
            network: p.network || "—",
            amount: amt,
            id: parsed.confirmationId || "—"
          });
        }
      } catch {
        // ignore non-JSON messages
      }
    }, [])
  });

  const handleCallTool = async (
    toolName: string,
    args: Record<string, unknown>
  ) => {
    try {
      const res = (await agent.call("callTool", [toolName, args])) as {
        text: string;
        isError: boolean;
      };
      setResults((prev) => [
        {
          label: toolName,
          text: res.text,
          isError: res.isError,
          timestamp: Date.now()
        },
        ...prev
      ]);
    } catch (err) {
      setResults((prev) => [
        {
          label: toolName,
          text: err instanceof Error ? err.message : String(err),
          isError: true,
          timestamp: Date.now()
        },
        ...prev
      ]);
    }
  };

  const handlePayment = (confirmed: boolean) => {
    if (!payment) return;
    agent.call("resolvePayment", [payment.id, confirmed]);
    setPayment(null);
  };

  return (
    <div className="h-full flex flex-col bg-kumo-base">
      <header className="px-5 py-4 border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <CurrencyDollarIcon
              size={22}
              className="text-kumo-accent"
              weight="bold"
            />
            <h1 className="text-lg font-semibold text-kumo-default">
              x402 MCP
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={status} />
            <ModeToggle />
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto p-5">
        <div className="max-w-3xl mx-auto space-y-6">
          <Surface className="p-4 rounded-xl ring ring-kumo-line">
            <div className="flex gap-3">
              <InfoIcon
                size={20}
                weight="bold"
                className="text-kumo-accent shrink-0 mt-0.5"
              />
              <div>
                <Text size="sm" bold>
                  Paid MCP Tools (x402)
                </Text>
                <span className="mt-1 block">
                  <Text size="xs" variant="secondary">
                    The <strong>echo</strong> tool is free. The{" "}
                    <strong>square</strong> tool costs $0.01 — calling it
                    triggers a payment confirmation between the client agent and
                    the MCP server using the x402 protocol.
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
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <EchoForm onCall={handleCallTool} />
                <SquareForm onCall={handleCallTool} />
              </div>

              {payment && (
                <PaymentModal
                  payment={payment}
                  onConfirm={() => handlePayment(true)}
                  onCancel={() => handlePayment(false)}
                />
              )}

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
                          <div className="min-w-0 flex-1">
                            <Text size="xs" variant="secondary" bold>
                              {r.label}
                            </Text>
                            <p
                              className={`text-sm mt-0.5 whitespace-pre-wrap break-words ${r.isError ? "text-red-600 dark:text-red-400" : "text-kumo-default"}`}
                            >
                              {r.text}
                            </p>
                          </div>
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

function EchoForm({
  onCall
}: {
  onCall: (tool: string, args: Record<string, unknown>) => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;
    setLoading(true);
    await onCall("echo", { message });
    setLoading(false);
    setMessage("");
  };

  return (
    <Surface className="p-4 rounded-xl ring ring-kumo-line">
      <div className="flex items-center gap-2 mb-3">
        <MegaphoneIcon size={18} weight="bold" />
        <Text size="sm" bold>
          Echo
        </Text>
        <Badge variant="outline">free</Badge>
      </div>
      <form onSubmit={handleSubmit} className="space-y-3">
        <label className="block text-xs text-kumo-subtle">
          Message
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="hello world"
            className="mt-1 w-full px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent"
          />
        </label>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={loading}
          icon={<PaperPlaneRightIcon size={14} />}
        >
          Call echo
        </Button>
      </form>
    </Surface>
  );
}

function SquareForm({
  onCall
}: {
  onCall: (tool: string, args: Record<string, unknown>) => Promise<void>;
}) {
  const [number, setNumber] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (number === "") return;
    setLoading(true);
    await onCall("square", { number: Number(number) });
    setLoading(false);
    setNumber("");
  };

  return (
    <Surface className="p-4 rounded-xl ring ring-kumo-line">
      <div className="flex items-center gap-2 mb-3">
        <HashIcon size={18} weight="bold" />
        <Text size="sm" bold>
          Square
        </Text>
        <Badge variant="secondary">$0.01</Badge>
      </div>
      <form onSubmit={handleSubmit} className="space-y-3">
        <label className="block text-xs text-kumo-subtle">
          Number
          <input
            type="number"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder="5"
            className="mt-1 w-full px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent"
          />
        </label>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={loading}
          icon={<PaperPlaneRightIcon size={14} />}
        >
          Call square (paid)
        </Button>
        <span className="block">
          <Text size="xs" variant="secondary">
            Triggers the x402 payment flow.
          </Text>
        </span>
      </form>
    </Surface>
  );
}

function PaymentModal({
  payment,
  onConfirm,
  onCancel
}: {
  payment: PaymentInfo;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Surface className="p-5 rounded-xl ring-2 ring-blue-500/30 bg-kumo-elevated">
      <div className="mb-4">
        <Text size="lg" bold>
          Payment Required
        </Text>
        <Text size="sm" variant="secondary">
          A paid tool has been requested. Confirm to continue.
        </Text>
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm mb-5">
        <Text size="xs" variant="secondary">
          Resource
        </Text>
        <Text size="sm" bold>
          {payment.resource}
        </Text>
        <Text size="xs" variant="secondary">
          Pay to
        </Text>
        <span className="font-mono text-xs break-all">{payment.address}</span>
        <Text size="xs" variant="secondary">
          Network
        </Text>
        <Text size="sm">{payment.network}</Text>
        <Text size="xs" variant="secondary">
          Amount
        </Text>
        <Text size="sm" bold>
          ${payment.amount} USD
        </Text>
      </div>
      <div className="flex justify-end gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={<XIcon size={14} />}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon={<CheckIcon size={14} />}
          onClick={onConfirm}
        >
          Confirm & Pay
        </Button>
      </div>
    </Surface>
  );
}

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>
);
