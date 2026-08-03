import { useState } from "react";
import { createRoot } from "react-dom/client";

type ReproResult = {
  detailLength: number;
  returnedTextLength: number;
  jsonValid: boolean;
  hasTruncationMarker: boolean;
  tail: string;
};

function App() {
  const [status, setStatus] = useState("Ready");
  const [log, setLog] = useState<string[]>([]);
  const add = (message: string) =>
    setLog((lines) => [...lines, `${new Date().toISOString()} ${message}`]);

  const trigger = async () => {
    setStatus("Running…");
    add("Calling codeMcpServer with a 70,000-character structured result");
    try {
      const response = await fetch("/agents/repro-agent/demo/trigger", {
        method: "POST"
      });
      const result = (await response.json()) as ReproResult & { error?: string };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      add(`JSON.parse succeeds: ${result.jsonValid}`);
      add(`Contains --- TRUNCATED ---: ${result.hasTruncationMarker}`);
      add(`Returned text length: ${result.returnedTextLength}`);
      add(`Tail: ${JSON.stringify(result.tail)}`);
      setStatus(
        result.jsonValid
          ? "Could not reproduce: response is valid JSON"
          : "Reproduced: codeMcpServer returned invalid JSON"
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      add(`Error: ${message}`);
      setStatus("Repro request failed");
    }
  };

  return (
    <main style={{ fontFamily: "monospace", maxWidth: 900, padding: 24 }}>
      <h1>#2009: codeMcpServer truncates structured results into invalid JSON</h1>
      <p>
        Expected: an intact structured result or a valid bounded envelope. Actual
        bug: a pretty-printed JSON prefix followed by a truncation marker.
      </p>
      <button onClick={trigger}>Trigger bug</button>
      <p><strong>Status:</strong> {status}</p>
      <pre style={{ whiteSpace: "pre-wrap" }}>{log.join("\n")}</pre>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
