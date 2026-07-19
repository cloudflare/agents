import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";

const JSON_HEADERS = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json"
};
const TIMEOUT_MS = 5_000;

type Log = (message: string) => void;

async function withTimeout<T>(
  label: string,
  promise: Promise<T>,
  log: Log
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} STALLED >${TIMEOUT_MS}ms`)),
          TIMEOUT_MS
        );
      })
    ]);
  } catch (error) {
    log(`❌ ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function post(
  body: unknown,
  sessionId: string | undefined,
  label: string,
  log: Log
): Promise<Response> {
  const started = performance.now();
  const response = await withTimeout(
    `${label} response headers`,
    fetch("/mcp", {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        ...(sessionId ? { "mcp-session-id": sessionId } : {})
      },
      body: JSON.stringify(body)
    }),
    log
  );
  log(
    `${label}: headers in ${Math.round(performance.now() - started)}ms, ` +
      `status=${response.status}, edge=${response.headers.get("x-repro-http-protocol") ?? "unknown"}`
  );
  return response;
}

async function runSequence(
  label: string,
  openStandaloneGet: boolean,
  log: Log
) {
  log(
    `— ${label}: ${openStandaloneGet ? "with" : "without"} standalone SSE GET —`
  );

  const init = await post(
    {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "issue-1965-browser-repro", version: "0" }
      }
    },
    undefined,
    `${label} initialize`,
    log
  );
  const sessionId = init.headers.get("mcp-session-id") ?? undefined;
  const initBody = await withTimeout(`${label} initialize body`, init.text(), log);
  log(
    `${label} initialize body: ${initBody.length} bytes; session=${sessionId ?? "missing"}`
  );
  if (!sessionId) throw new Error("initialize did not return mcp-session-id");

  const initialized = await post(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionId,
    `${label} initialized notification`,
    log
  );
  await withTimeout(`${label} initialized body`, initialized.text(), log);

  let standalone: Response | undefined;
  if (openStandaloneGet) {
    const started = performance.now();
    standalone = await withTimeout(
      `${label} standalone GET response headers`,
      fetch("/mcp", {
        headers: {
          accept: "text/event-stream",
          "mcp-session-id": sessionId
        }
      }),
      log
    );
    log(
      `${label} standalone GET: headers in ${Math.round(performance.now() - started)}ms, ` +
        `status=${standalone.status}, edge=${standalone.headers.get("x-repro-http-protocol") ?? "unknown"}; body left open`
    );
  }

  const started = performance.now();
  const tools = await post(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    sessionId,
    `${label} tools/list`,
    log
  );
  const toolsBody = await withTimeout(
    `${label} tools/list body`,
    tools.text(),
    log
  );
  const elapsed = Math.round(performance.now() - started);
  log(
    `✅ ${label} tools/list body completed in ${elapsed}ms (${toolsBody.length} bytes)`
  );

  // Keep the test GET open after success so DevTools still shows the exact
  // reported condition. It is canceled before the next click.
  return standalone;
}

function App() {
  const [logLines, setLogLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const openStreams = useRef<Response[]>([]);
  const add: Log = (message) =>
    setLogLines((lines) => [
      ...lines,
      `${new Date().toISOString()} ${message}`
    ]);

  async function trigger() {
    if (running) return;
    setRunning(true);
    setLogLines([]);
    for (const response of openStreams.current) {
      response.body?.cancel().catch(() => {});
    }
    openStreams.current = [];
    try {
      await runSequence("CONTROL", false, add);
      const stream = await runSequence("TEST", true, add);
      if (stream) openStreams.current.push(stream);
      add(
        "RESULT: runtime/Agents PASS — browser H2 multiplexing completed while GET remained open. The reproducible stall is specific to Undici constrained to one connection (see the repro branch)."
      );
    } catch (error) {
      add(
        `RESULT: reproduced a stall/failure: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setRunning(false);
    }
  }

  return (
    <main style={{ fontFamily: "monospace", padding: 16, maxWidth: 1000 }}>
      <h1>#1965 McpAgent H2 + standalone SSE GET</h1>
      <p>
        Expected: <code>tools/list</code> completes with the standalone GET
        open. This page exercises real browser H2 multiplexing against
        <code>agents@0.13.3</code>; it distinguishes a server/runtime stall from
        the isolated Node/Undici client behavior.
      </p>
      <button disabled={running} onClick={trigger}>
        {running ? "Running…" : "Trigger bug"}
      </button>
      <pre style={{ whiteSpace: "pre-wrap", paddingTop: 12 }}>
        {logLines.join("\n")}
      </pre>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
