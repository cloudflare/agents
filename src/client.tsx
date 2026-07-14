import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";

function App() {
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const add = (m: string) =>
    setLog((l) => [...l, `${new Date().toISOString()} ${m}`]);

  const agent = useAgent({
    agent: "repro-agent",
    name: "demo",
    onOpen: () => add("ws connected"),
    onClose: () => add("ws closed")
  });

  return (
    <main style={{ fontFamily: "monospace", padding: 16, maxWidth: 900 }}>
      <h1>Issue #1938 — Think compiles the whole MCP catalog into Zod on every turn</h1>
      <p>
        A 313-tool MCP catalog (complex nested schemas) is registered through a
        Durable Object binding, intended for Code Mode only. Direct MCP tools
        are excluded from the model via <code>activeTools</code>.
      </p>
      <p>
        <b>Expected:</b> a normal turn does NOT materialize the excluded MCP
        tool schemas.
        <br />
        <b>Actual (bug):</b> <code>_runInferenceLoop</code> calls{" "}
        <code>mcp.getAITools()</code> unconditionally, compiling a Zod schema
        for every MCP tool's input <i>and</i> output before filtering.
      </p>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          add("trigger: runRepro()");
          try {
            const r = await agent.call("runRepro");
            add("RESULT: " + JSON.stringify(r, null, 2));
          } catch (e) {
            add("ERROR: " + String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "running…" : "Trigger repro"}
      </button>
      <pre style={{ whiteSpace: "pre-wrap" }}>{log.join("\n")}</pre>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
