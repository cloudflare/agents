import "./styles.css";
import {
  Button,
  DropdownMenu,
  Input,
  Surface,
  Textarea
} from "@cloudflare/kumo";
import {
  CaretDown,
  FileText,
  GithubLogo,
  Info,
  Monitor,
  Moon,
  Play,
  Plus,
  Sun,
  X
} from "@phosphor-icons/react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useState } from "react";

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

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  size?: "sm" | "lg";
  children: React.ReactNode;
}

function Modal({ open, onClose, title, size = "sm", children }: ModalProps) {
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close modal"
        className="absolute inset-0 cursor-default bg-black/45"
        onClick={onClose}
      />
      <div
        className={`relative flex flex-col gap-4 rounded-xl border border-kumo-line bg-kumo-base p-6 shadow-lg ${
          size === "lg" ? "w-[480px]" : "w-[360px]"
        } max-w-[calc(100vw-2rem)]`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[15px] font-semibold text-kumo-default">
            {title}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-kumo-line bg-kumo-base text-kumo-default"
          >
            <X size={14} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}

type PlaygroundFiles = Record<string, string>;

interface RunResult {
  bundleInfo: {
    mainModule: string;
    modules: string[];
    warnings: string[];
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: string;
  };
  workerError: {
    message: string;
    stack?: string;
  } | null;
  logs: Array<{
    level: string;
    message: string;
    timestamp: number;
  }>;
  timing: {
    buildTime: number;
    loadTime: number;
    runTime: number;
    totalTime: number;
  };
}

interface GitHubImportResult {
  error?: string;
  files?: PlaygroundFiles;
}

type StatusTone = "idle" | "running" | "success" | "error";

const EXAMPLES: Array<{
  id: string;
  label: string;
  files: PlaygroundFiles;
}> = [
  {
    id: "simple",
    label: "Simple Worker",
    files: {
      "src/index.ts": `export default {
  fetch(request: Request): Response {
    return new Response("Hello from dynamic worker!");
  }
};`,
      "package.json": JSON.stringify(
        { name: "simple-worker", main: "src/index.ts" },
        null,
        2
      )
    }
  },
  {
    id: "multi-file",
    label: "Multi-file Worker",
    files: {
      "src/index.ts": `import { greet } from "./utils";
import { formatDate } from "./helpers/date";

export default {
  fetch(request: Request): Response {
    const message = greet("World");
    const time = formatDate(new Date());
    return new Response(\`\${message}\\nTime: \${time}\`);
  }
};`,
      "src/utils.ts": `export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}`,
      "src/helpers/date.ts": `export function formatDate(date: Date): string {
  return date.toISOString();
}`,
      "package.json": JSON.stringify(
        { name: "multi-file-worker", main: "src/index.ts" },
        null,
        2
      )
    }
  },
  {
    id: "json-config",
    label: "JSON Config",
    files: {
      "src/index.ts": `import config from "./config.json";

export default {
  fetch(request: Request): Response {
    return new Response(
      JSON.stringify(
        {
          app: config.name,
          version: config.version,
          features: config.features
        },
        null,
        2
      ),
      {
        headers: { "Content-Type": "application/json" }
      }
    );
  }
};`,
      "src/config.json": JSON.stringify(
        {
          name: "My App",
          version: "1.0.0",
          features: ["auth", "api", "webhooks"]
        },
        null,
        2
      ),
      "package.json": JSON.stringify(
        { name: "config-worker", main: "src/index.ts" },
        null,
        2
      )
    }
  },
  {
    id: "with-env",
    label: "With Env Bindings",
    files: {
      "src/index.ts": `interface Env {
  API_KEY: string;
  DEBUG: string;
}

export default {
  fetch(request: Request, env: Env): Response {
    const data = {
      hasApiKey: !!env.API_KEY,
      apiKeyPreview: env.API_KEY ? env.API_KEY.slice(0, 4) + "..." : null,
      debugMode: env.DEBUG === "true"
    };

    return new Response(JSON.stringify(data, null, 2), {
      headers: { "Content-Type": "application/json" }
    });
  }
};`,
      "package.json": JSON.stringify(
        { name: "env-worker", main: "src/index.ts" },
        null,
        2
      )
    }
  },
  {
    id: "api-router",
    label: "API Router",
    files: {
      "src/index.ts": `import { handleUsers } from "./routes/users";
import { handleHealth } from "./routes/health";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return handleHealth();
    }

    if (url.pathname.startsWith("/users")) {
      return handleUsers(request);
    }

    return new Response(
      JSON.stringify(
        {
          error: "Not Found",
          availableRoutes: ["/health", "/users"]
        },
        null,
        2
      ),
      {
        status: 404,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
};`,
      "src/routes/users.ts": `const users = [
  { id: 1, name: "Alice" },
  { id: 2, name: "Bob" }
];

export function handleUsers(request: Request): Response {
  return new Response(JSON.stringify({ users }), {
    headers: { "Content-Type": "application/json" }
  });
}`,
      "src/routes/health.ts": `export function handleHealth(): Response {
  return new Response(
    JSON.stringify(
      {
        status: "healthy",
        timestamp: new Date().toISOString()
      },
      null,
      2
    ),
    {
      headers: { "Content-Type": "application/json" }
    }
  );
}`,
      "package.json": JSON.stringify(
        { name: "api-router", main: "src/index.ts" },
        null,
        2
      )
    }
  }
];

function snapshotFiles(files: PlaygroundFiles) {
  return JSON.stringify(files);
}

function inferPrimaryFile(files: PlaygroundFiles) {
  return (
    Object.keys(files).find(
      (file) => file === "src/index.ts" || file === "src/index.js"
    ) ||
    Object.keys(files).find(
      (file) => file.endsWith(".ts") || file.endsWith(".js")
    ) ||
    Object.keys(files)[0]
  );
}

function prettyBody(body: string) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function getContentType(headers: Record<string, string>) {
  const match = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === "content-type"
  );
  return match?.[1] ?? "text/plain";
}

const STATUS_DOT_COLORS: Record<StatusTone, string> = {
  success: "bg-status-success",
  error: "bg-status-error",
  running: "bg-status-warning",
  idle: "bg-status-idle"
};

function consolePrefix(level: string) {
  if (level === "error") return "✕";
  if (level === "warn") return "!";
  return "›";
}

function consoleColor(level: string) {
  if (level === "error") return "text-status-error";
  if (level === "warn") return "text-status-warning";
  return "text-kumo-default";
}

function LayersLogo() {
  return (
    <svg
      viewBox="0 0 48 49"
      aria-hidden="true"
      className="h-8 w-8 shrink-0 fill-kumo-brand"
    >
      <path d="m18.63 37.418-9.645-12.9 9.592-12.533-1.852-2.527L5.917 23.595l-.015 1.808 10.86 14.542z" />
      <path d="M21.997 6.503h-3.712l13.387 18.3-13.072 17.7h3.735L35.4 24.81z" />
      <path d="M29.175 6.503h-3.758l13.598 18.082-13.598 17.918h3.765l12.908-17.01v-1.808z" />
    </svg>
  );
}

function SectionLabel({
  children,
  className
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      className={`mb-1.5 text-[11px] font-semibold uppercase tracking-wide ${className ?? "text-kumo-inactive"}`}
    >
      {children}
    </p>
  );
}

export function App() {
  const { mode, toggle: toggleTheme } = useTheme();
  const initialExample = EXAMPLES[0];
  const [files, setFiles] = useState<PlaygroundFiles>({
    ...initialExample.files
  });
  const [currentFile, setCurrentFile] = useState(
    inferPrimaryFile(initialExample.files)
  );
  const [bundle, setBundle] = useState(true);
  const [minify, setMinify] = useState(false);
  const [status, setStatus] = useState<{ tone: StatusTone; label: string }>({
    tone: "idle",
    label: "Ready"
  });
  const [workerVersion, setWorkerVersion] = useState(0);
  const [lastSnapshot, setLastSnapshot] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<{
    message: string;
    stack?: string;
  } | null>(null);
  const [running, setRunning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [addFileOpen, setAddFileOpen] = useState(false);
  const [githubOpen, setGithubOpen] = useState(false);
  const [addFileName, setAddFileName] = useState("");
  const [githubUrl, setGitHubUrl] = useState("");

  const orderedFiles = useMemo(() => Object.keys(files), [files]);
  const currentValue = currentFile ? (files[currentFile] ?? "") : "";

  function applyFiles(nextFiles: PlaygroundFiles) {
    setFiles(nextFiles);
    setCurrentFile(inferPrimaryFile(nextFiles));
    setResult(null);
    setError(null);
    setStatus({ tone: "idle", label: "Ready" });
  }

  function handleExampleChange(exampleId: string) {
    const example = EXAMPLES.find((item) => item.id === exampleId);
    if (!example) return;
    applyFiles({ ...example.files });
  }

  function updateCurrentFile(value: string) {
    if (!currentFile) return;
    setFiles((prev) => ({ ...prev, [currentFile]: value }));
  }

  function handleAddFile() {
    const filename = addFileName.trim();
    if (!filename) return;
    if (files[filename]) {
      window.alert("File already exists");
      return;
    }

    const nextFiles = {
      ...files,
      [filename]: filename.endsWith(".json") ? "{}" : ""
    };

    setFiles(nextFiles);
    setCurrentFile(filename);
    setAddFileName("");
    setAddFileOpen(false);
  }

  function removeFile(filename: string) {
    if (Object.keys(files).length <= 1) {
      window.alert("Cannot delete the last file");
      return;
    }

    const nextFiles = { ...files };
    delete nextFiles[filename];
    setFiles(nextFiles);

    if (currentFile === filename) {
      setCurrentFile(Object.keys(nextFiles)[0]);
    }
  }

  function formatCurrentFile() {
    if (!currentFile || !currentFile.endsWith(".json")) {
      return;
    }

    try {
      const parsed = JSON.parse(currentValue);
      updateCurrentFile(JSON.stringify(parsed, null, 2));
    } catch {
      // Ignore invalid JSON formatting requests.
    }
  }

  async function importFromGitHub() {
    const url = githubUrl.trim();

    if (!url) {
      window.alert("Please enter a GitHub URL");
      return;
    }

    if (!url.startsWith("https://github.com/")) {
      window.alert("Please enter a valid GitHub URL (https://github.com/...)");
      return;
    }

    setImporting(true);
    setStatus({ tone: "running", label: "Importing from GitHub..." });

    try {
      const response = await fetch("/api/github", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url })
      });

      const rawData: unknown = await response.json();
      const data = rawData as GitHubImportResult;
      if (!response.ok || data.error) {
        throw new Error(data.error || "GitHub import failed.");
      }

      const importedFiles = data.files ?? {};
      if (!importedFiles["package.json"]) {
        const mainFile =
          Object.keys(importedFiles).find(
            (file) =>
              file === "src/index.ts" ||
              file === "src/index.js" ||
              file === "index.ts" ||
              file === "index.js"
          ) ||
          Object.keys(importedFiles).find(
            (file) => file.endsWith(".ts") || file.endsWith(".js")
          );

        if (mainFile) {
          importedFiles["package.json"] = JSON.stringify(
            { name: "imported-worker", main: mainFile },
            null,
            2
          );
        }
      }

      applyFiles(importedFiles);
      setGitHubUrl("");
      setGithubOpen(false);
      setStatus({
        tone: "success",
        label: `Imported ${Object.keys(importedFiles).length} file${Object.keys(importedFiles).length === 1 ? "" : "s"}`
      });
    } catch (importError) {
      setStatus({ tone: "error", label: "Import failed" });
      window.alert(
        importError instanceof Error ? importError.message : String(importError)
      );
    } finally {
      setImporting(false);
    }
  }

  async function runWorker() {
    setRunning(true);
    setError(null);
    setStatus({ tone: "running", label: "Bundling..." });

    try {
      const nextSnapshot = snapshotFiles(files);
      const nextVersion =
        nextSnapshot === lastSnapshot ? workerVersion : workerVersion + 1;

      if (nextVersion !== workerVersion) {
        setWorkerVersion(nextVersion);
        setLastSnapshot(nextSnapshot);
      }

      const response = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          files,
          version: nextVersion,
          options: { bundle, minify }
        })
      });

      const rawPayload: unknown = await response.json();
      const payload = rawPayload as RunResult & {
        error?: string;
        stack?: string;
      };
      if (!response.ok || payload.error) {
        throw new Error(payload.error || "Failed to run worker.");
      }

      setResult(payload);

      if (payload.workerError) {
        setStatus({ tone: "error", label: "Runtime Error" });
      } else {
        setStatus({ tone: "success", label: "Success" });
      }
    } catch (runError) {
      const nextError = {
        message:
          runError instanceof Error ? runError.message : String(runError),
        stack: runError instanceof Error ? runError.stack : undefined
      };

      setResult(null);
      setError(nextError);
      setStatus({ tone: "error", label: "Bundle Error" });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-4 px-4 py-6">
        {/* Explainer card */}
        <Surface className="rounded-xl">
          <div className="flex items-start gap-3 p-4">
            <Info
              size={20}
              weight="bold"
              className="mt-0.5 shrink-0 text-kumo-accent"
            />
            <div>
              <p className="text-sm font-semibold text-kumo-default">
                Dynamic Workers Playground
              </p>
              <p className="mt-1 text-[13px] text-kumo-inactive">
                Write, bundle, and run Cloudflare Worker code directly in your
                browser using{" "}
                <code className="rounded bg-kumo-elevated px-1 font-mono">
                  @cloudflare/worker-bundler
                </code>
                . Edit files, load an example, or import from GitHub — then
                click <strong>Run Worker</strong> to see the response, console
                logs, and timing in real time.
              </p>
            </div>
          </div>
        </Surface>

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <LayersLogo />
            <div>
              <h1 className="text-lg font-bold text-kumo-default">
                Dynamic Workers Playground
              </h1>
              <p className="text-xs text-kumo-inactive">
                Build and run Workers dynamically from source code
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2" aria-live="polite">
              <span
                className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT_COLORS[status.tone]}`}
              />
              <span className="text-[13px] text-kumo-inactive">
                {status.label}
              </span>
            </div>

            <Button
              variant="ghost"
              shape="square"
              aria-label="Toggle theme"
              onClick={toggleTheme}
              icon={mode === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            />
          </div>
        </div>

        {/* Main grid */}
        <div className="grid flex-1 grid-cols-2 gap-4">
          {/* Source panel */}
          <Surface className="flex min-h-[600px] min-w-0 flex-col rounded-xl">
            {/* Panel header */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-kumo-line px-4 py-3">
              <div className="flex min-w-0 shrink items-center gap-1.5 text-[13px] font-semibold text-kumo-default">
                <FileText size={16} className="shrink-0" />
                <span>Source Files</span>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <DropdownMenu>
                  <DropdownMenu.Trigger
                    render={
                      <Button variant="secondary">
                        Load Example...
                        <CaretDown size={13} />
                      </Button>
                    }
                  />
                  <DropdownMenu.Content>
                    {EXAMPLES.map((example) => (
                      <DropdownMenu.Item
                        key={example.id}
                        onClick={() => handleExampleChange(example.id)}
                      >
                        {example.label}
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.Content>
                </DropdownMenu>

                <Button variant="secondary" onClick={() => setGithubOpen(true)}>
                  <GithubLogo size={16} weight="fill" />
                  Import from GitHub
                </Button>
              </div>
            </div>

            {/* File tabs */}
            <div className="flex min-w-0 items-stretch border-b border-kumo-line">
              <div className="flex min-w-0 flex-auto flex-nowrap items-center gap-0.5 overflow-x-auto overflow-y-hidden px-2">
                {orderedFiles.map((filename) => (
                  <button
                    key={filename}
                    type="button"
                    onClick={() => setCurrentFile(filename)}
                    className={`flex shrink-0 cursor-pointer items-center gap-1 border-b-2 bg-transparent px-2.5 py-2 font-mono text-xs ${
                      filename === currentFile
                        ? "border-kumo-brand text-kumo-default"
                        : "border-transparent text-kumo-inactive"
                    }`}
                  >
                    <span>{filename}</span>
                    {filename !== "package.json" ? (
                      <button
                        type="button"
                        aria-label={`Remove ${filename}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeFile(filename);
                        }}
                        className="cursor-pointer border-none bg-transparent px-0.5 text-[10px] leading-none opacity-60"
                      >
                        ×
                      </button>
                    ) : null}
                  </button>
                ))}
              </div>

              <div className="flex shrink-0 items-center pr-2">
                <button
                  type="button"
                  onClick={() => setAddFileOpen(true)}
                  aria-label="Add new file"
                  className="flex cursor-pointer items-center rounded bg-transparent p-1.5 text-kumo-inactive"
                >
                  <Plus size={14} weight="bold" />
                </button>
              </div>
            </div>

            {/* Editor */}
            <div className="flex flex-1 flex-col">
              <Textarea
                aria-label="Worker source code"
                spellCheck={false}
                placeholder="Select a file or add a new one..."
                value={currentValue}
                onChange={(e) => updateCurrentFile(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Tab") return;
                  e.preventDefault();
                  const target = e.currentTarget;
                  const start = target.selectionStart;
                  const end = target.selectionEnd;
                  const next = `${currentValue.slice(0, start)}  ${currentValue.slice(end)}`;
                  updateCurrentFile(next);
                  queueMicrotask(() => {
                    target.selectionStart = start + 2;
                    target.selectionEnd = start + 2;
                  });
                }}
                className="min-h-[380px] flex-1 resize-none rounded-none border-none font-mono text-[13px]"
              />
            </div>

            {/* Controls */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-kumo-line px-4 py-3">
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  disabled={running}
                  onClick={() => void runWorker()}
                >
                  <Play size={14} weight="fill" />
                  {running ? "Running..." : "Run Worker"}
                </Button>
                <Button variant="secondary" onClick={formatCurrentFile}>
                  Format
                </Button>
              </div>

              <div className="flex gap-4">
                {[
                  { label: "Bundle", checked: bundle, onChange: setBundle },
                  { label: "Minify", checked: minify, onChange: setMinify }
                ].map(({ label, checked, onChange }) => (
                  <label
                    key={label}
                    className="flex cursor-pointer select-none items-center gap-1.5 text-[13px] text-kumo-default"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => onChange(e.target.checked)}
                      className="h-3.5 w-3.5 cursor-pointer accent-kumo-brand"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          </Surface>

          {/* Output panel */}
          <Surface className="flex min-h-[600px] min-w-0 flex-col rounded-xl">
            <div className="flex items-center gap-1.5 border-b border-kumo-line px-4 py-3 text-[13px] font-semibold text-kumo-default">
              <Monitor size={16} />
              <span>Output</span>
            </div>

            <div className="flex flex-1 flex-col gap-4 overflow-auto p-4">
              {error ? (
                <div>
                  <SectionLabel className="text-status-error">
                    Error
                  </SectionLabel>
                  <pre className="font-mono text-xs text-status-error whitespace-pre-wrap break-words">
                    {error.message}
                  </pre>
                  {error.stack ? (
                    <pre className="mt-2 font-mono text-[11px] text-kumo-inactive whitespace-pre-wrap break-words">
                      {error.stack}
                    </pre>
                  ) : null}
                </div>
              ) : null}

              {!error && !result ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 text-kumo-inactive">
                  <Play size={48} />
                  <p className="text-sm">
                    Click &ldquo;Run Worker&rdquo; to bundle and execute your
                    code
                  </p>
                </div>
              ) : null}

              {!error && result ? (
                <>
                  {/* Response */}
                  <div>
                    <SectionLabel
                      className={
                        result.workerError
                          ? "text-status-error"
                          : "text-kumo-inactive"
                      }
                    >
                      {result.workerError
                        ? "Worker Error"
                        : `Response (${result.response.status})`}
                    </SectionLabel>

                    {result.workerError ? (
                      <>
                        <pre className="font-mono text-xs text-status-error whitespace-pre-wrap break-words">
                          {result.workerError.message}
                        </pre>
                        {result.workerError.stack ? (
                          <pre className="mt-2 font-mono text-[11px] text-kumo-inactive whitespace-pre-wrap break-words">
                            {result.workerError.stack}
                          </pre>
                        ) : null}
                      </>
                    ) : (
                      <div>
                        <p className="mb-1 font-mono text-[11px] text-kumo-inactive">
                          Content-Type:{" "}
                          {getContentType(result.response.headers)}
                        </p>
                        <pre className="rounded-md bg-kumo-elevated p-2.5 font-mono text-xs text-status-success whitespace-pre-wrap break-words">
                          {prettyBody(result.response.body)}
                        </pre>
                      </div>
                    )}
                  </div>

                  {/* Console */}
                  <div>
                    <SectionLabel>
                      Console
                      {result.logs.length
                        ? ` (${result.logs.length} log${result.logs.length === 1 ? "" : "s"})`
                        : ""}
                    </SectionLabel>
                    <div className="rounded-md bg-kumo-elevated p-2.5 font-mono text-xs">
                      {result.logs.length ? (
                        result.logs.map((log, i) => (
                          <div
                            key={`${log.timestamp}-${i}`}
                            className={`flex gap-1.5 ${consoleColor(log.level)}`}
                          >
                            <span className="opacity-50">
                              {consolePrefix(log.level)}
                            </span>
                            <span>{log.message}</span>
                          </div>
                        ))
                      ) : (
                        <span className="text-xs text-kumo-inactive">
                          No console output. Use <code>console.log()</code> in
                          your worker to see logs here.
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Timing */}
                  <div>
                    <SectionLabel>
                      Timing ({result.timing.loadTime > 0 ? "cold" : "warm"})
                    </SectionLabel>
                    <div className="grid grid-cols-4 gap-2">
                      {[
                        { label: "Build", value: result.timing.buildTime },
                        { label: "Load", value: result.timing.loadTime },
                        { label: "Run", value: result.timing.runTime },
                        { label: "Total", value: result.timing.totalTime }
                      ].map(({ label, value }) => (
                        <div
                          key={label}
                          className="rounded-md bg-kumo-elevated px-2.5 py-2 text-center"
                        >
                          <p className="text-[11px] text-kumo-inactive">
                            {label}
                          </p>
                          <p className="mt-0.5 font-mono text-sm font-semibold">
                            {value}ms
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Bundle info */}
                  <div>
                    <SectionLabel>Bundle Info</SectionLabel>
                    <div className="flex flex-col gap-2 rounded-md bg-kumo-elevated p-2.5 text-xs">
                      <p className="font-mono">
                        <strong>Main:</strong> {result.bundleInfo.mainModule}
                      </p>

                      <div>
                        <p className="mb-1 text-[11px] uppercase tracking-wide text-kumo-inactive">
                          Modules ({result.bundleInfo.modules.length})
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {result.bundleInfo.modules.map((m) => (
                            <span
                              key={m}
                              className="rounded bg-kumo-base px-1.5 py-0.5 font-mono text-[11px] text-kumo-accent"
                            >
                              {m}
                            </span>
                          ))}
                        </div>
                      </div>

                      {result.bundleInfo.warnings.length ? (
                        <div>
                          <p className="mb-1 text-[11px] uppercase tracking-wide text-status-warning">
                            Warnings
                          </p>
                          <pre className="font-mono text-[11px] text-status-warning whitespace-pre-wrap">
                            {result.bundleInfo.warnings.join("\n")}
                          </pre>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          </Surface>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-center gap-2 py-3 text-xs text-kumo-inactive">
          <span>Powered by</span>
          <a
            href="https://workers.cloudflare.com"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 font-medium text-inherit no-underline"
          >
            <LayersLogo />
            <span>Cloudflare Workers</span>
          </a>
        </div>
      </div>

      {/* Add file modal */}
      <Modal
        open={addFileOpen}
        onClose={() => setAddFileOpen(false)}
        title="Add New File"
        size="sm"
      >
        <Input
          aria-label="New file name"
          placeholder="e.g., src/utils.ts"
          value={addFileName}
          onChange={(e) => setAddFileName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAddFile();
          }}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setAddFileOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleAddFile}>
            Add File
          </Button>
        </div>
      </Modal>

      {/* GitHub import modal */}
      <Modal
        open={githubOpen}
        onClose={() => setGithubOpen(false)}
        title={
          <>
            <GithubLogo size={18} weight="fill" />
            Import from GitHub
          </>
        }
        size="lg"
      >
        <p className="text-[13px] text-kumo-inactive break-words">
          Paste a GitHub URL to import files from any repository. Supports
          repos, branches, and subdirectories.
        </p>
        <Input
          aria-label="GitHub URL"
          placeholder="https://github.com/owner/repo/tree/branch/path"
          value={githubUrl}
          onChange={(e) => setGitHubUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void importFromGitHub();
          }}
          className="w-full"
        />
        <div className="text-xs">
          <span className="text-kumo-inactive">Example: </span>
          <button
            type="button"
            className="cursor-pointer border-none bg-transparent p-0 text-xs text-kumo-accent underline"
            onClick={() =>
              setGitHubUrl(
                "https://github.com/honojs/starter/tree/main/templates/cloudflare-workers"
              )
            }
          >
            Hono Starter
          </button>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setGithubOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={importing}
            onClick={() => void importFromGitHub()}
          >
            Import
          </Button>
        </div>
      </Modal>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<App />);
}
