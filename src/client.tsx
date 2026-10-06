import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";

type ReproResult = {
  instance: string;
  desiredInstanceWindowMs: number | null;
  effectiveExpectedWindowMs: number;
  libraryStaticWindowMs: number;
  evidenceAgeMs: number;
  expectedStatus: string;
  actualStatus: string | null;
  actualError: string | null;
  instanceGetterReadsDuringRecovery: number;
  recoverableFiberBefore: boolean;
  recoverableFiberAfter: boolean;
  statusEvents: string[];
  reproduced: boolean;
};

function App() {
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const add = (message: string) =>
    setLog((current) => [
      ...current,
      `${new Date().toISOString()} ${message}`
    ]);

  useAgent({
    agent: "recovery-window-agent",
    name: "long-running",
    onOpen: () => add("WebSocket connected to long-running instance"),
    onClose: () => add("WebSocket closed"),
    onMessage: (event) => add(`WebSocket: ${event.data}`)
  });

  async function run() {
    setRunning(true);
    setLog([]);
    try {
      for (const instance of ["long-running", "interactive"]) {
        add(`Triggering ${instance} instance...`);
        const response = await fetch(
          `/agents/recovery-window-agent/${instance}/run`,
          { method: "POST" }
        );
        const text = await response.text();
        if (!response.ok) throw new Error(`${response.status}: ${text}`);
        const result = JSON.parse(text) as ReproResult;
        add(`${instance}: ${JSON.stringify(result, null, 2)}`);
      }
      add(
        "BUG: long-running requested a 60-minute instance window, but the 16-minute-old recoverable turn was marked error using the class-wide 15-minute window."
      );
    } catch (error) {
      add(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRunning(false);
    }
  }

  return (
    <main
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        maxWidth: 1000,
        margin: "0 auto",
        padding: 24
      }}
    >
      <h1>#2498: per-instance submissionRecoveryStaleMs</h1>
      <p>
        <strong>Expected:</strong> the <code>long-running</code> instance uses a
        60-minute recovery window while <code>interactive</code> keeps the
        15-minute default.
      </p>
      <p>
        <strong>Actual bug:</strong> @cloudflare/think 0.20.0 reads only the
        protected static class value. A 16-minute-old recoverable turn is
        terminally errored for both instances, and the long instance&apos;s getter
        is never read.
      </p>
      <button disabled={running} onClick={run} style={{ padding: "8px 14px" }}>
        {running ? "Running..." : "Trigger bug"}
      </button>
      <pre
        style={{
          marginTop: 20,
          padding: 16,
          minHeight: 220,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          background: "#111",
          color: "#c8ffc8"
        }}
      >
        {log.join("\n") || "Press Trigger bug to run both agent instances."}
      </pre>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
