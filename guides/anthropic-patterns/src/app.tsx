import "./app.css";

import { useAgent } from "agents/react";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useMemo, useState } from "react";
import sequentialCode from "./flows/01 sequential.txt?raw";
import routingCode from "./flows/02 routing.txt?raw";
import parallelCode from "./flows/03 parallel.txt?raw";
import orchestratorCode from "./flows/04 orchestrator.txt?raw";
import evaluatorCode from "./flows/05 evaluator.txt?raw";

type ToastType = "success" | "error" | "info";

type Toast = {
  id: number;
  type: ToastType;
  message: string;
};

type WorkflowStatus = {
  isRunning: boolean;
  output: string;
};

type WorkflowType =
  | "sequential"
  | "routing"
  | "parallel"
  | "orchestrator"
  | "evaluator";

type PatternProps = {
  type: WorkflowType;
  title: string;
  description: string;
  image: string;
  code: string;
  index: number;
};

type FormState = {
  sequential: { input: string };
  routing: { query: string };
  parallel: { code: string };
  orchestrator: { featureRequest: string };
  evaluator: { text: string; targetLanguage: string };
};

const LANGUAGES = [
  { label: "French", value: "french" },
  { label: "Spanish", value: "spanish" },
  { label: "Japanese", value: "japanese" },
  { label: "German", value: "german" },
  { label: "Mandarin Chinese", value: "mandarin" },
  { label: "Arabic", value: "arabic" },
  { label: "Russian", value: "russian" },
  { label: "Italian", value: "italian" },
  { label: "Klingon", value: "klingon" },
  { label: "Portuguese", value: "portuguese" }
] as const;

function Toast({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onClose();
    }, 5000);

    return () => clearTimeout(timer);
  }, [onClose]);

  const getIcon = (type: ToastType) => {
    switch (type) {
      case "success":
        return "✅";
      case "error":
        return "❌";
      case "info":
        return "ℹ️";
    }
  };

  return (
    <div className={`toast ${toast.type}`}>
      <span className="toast-icon">{getIcon(toast.type)}</span>
      <span className="toast-message">{toast.message}</span>
      <button type="button" className="toast-close" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}

function ToastContainer({
  toasts,
  onClose
}: {
  toasts: Toast[];
  onClose: (id: number) => void;
}) {
  return (
    <div className="toast-container">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onClose={() => onClose(toast.id)} />
      ))}
    </div>
  );
}

function getOrCreateSessionId() {
  const stored = globalThis.localStorage?.getItem("sessionId");
  if (stored) return stored;

  const newId = nanoid(8);
  globalThis.localStorage?.setItem("sessionId", newId);
  return newId;
}

function PatternSection({
  type,
  title,
  description,
  image,
  code,
  index,
  sessionId
}: PatternProps & { sessionId: string }) {
  const [activeTab, setActiveTab] = useState<"diagram" | "code">("diagram");
  const [isCodeExpanded, setIsCodeExpanded] = useState(false);

  const socket = useAgent({
    agent: type,
    name: sessionId,
    onMessage: (e) => {
      const data = JSON.parse(e.data);
      switch (data.type) {
        case "status":
          setWorkflowStatus(data.status);
          break;
        case "toast": {
          const event = new CustomEvent("showToast", {
            detail: {
              message: data.toast.message,
              type: data.toast.type as ToastType
            }
          });
          window.dispatchEvent(event);
          break;
        }
      }
    },
    prefix: "agents"
  });

  const [workflowStatus, setWorkflowStatus] = useState<WorkflowStatus>({
    isRunning: false,
    output: ""
  });

  const [formState, setFormState] = useState<FormState[typeof type]>(() => {
    switch (type) {
      case "sequential":
        return { input: "Our new AI-powered productivity app" };
      case "routing":
        return { query: "How do I reset my password?" };
      case "parallel":
        return {
          code: `function processUserData(data) {
  // TODO: Add validation
  database.save(data);
  return true;
}`
        };
      case "orchestrator":
        return {
          featureRequest:
            "Add dark mode support to the dashboard, including theme persistence and system preference detection"
        };
      case "evaluator":
        return {
          targetLanguage: LANGUAGES[0].value,
          text: "The early bird catches the worm"
        };
    }
  });

  const handleInputChange = (
    e: React.ChangeEvent<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >
  ) => {
    const { name, value } = e.target;
    setFormState((prev) => ({ ...prev, [name]: value }));
  };

  const getFormContent = () => {
    if (type === "sequential") {
      const state = formState as FormState["sequential"];
      return (
        <div className="form-group">
          <label htmlFor="sequential-input">Marketing Copy Input</label>
          <input
            id="sequential-input"
            type="text"
            name="input"
            value={state.input}
            onChange={handleInputChange}
            placeholder="e.g., 'Our new AI-powered productivity app'"
            className="workflow-input"
          />
          <small className="input-help">
            Enter a product or service to generate marketing copy for
          </small>
        </div>
      );
    }

    if (type === "routing") {
      const state = formState as FormState["routing"];
      return (
        <div className="form-group">
          <label htmlFor="routing-query">Customer Query</label>
          <input
            id="routing-query"
            type="text"
            name="query"
            value={state.query}
            onChange={handleInputChange}
            placeholder="e.g., 'How do I reset my password?'"
            className="workflow-input"
          />
          <small className="input-help">
            Enter a customer support question to be routed
          </small>
        </div>
      );
    }

    if (type === "parallel") {
      const state = formState as FormState["parallel"];
      return (
        <div className="form-group">
          <label htmlFor="parallel-code">Code for Review</label>
          <textarea
            id="parallel-code"
            name="code"
            value={state.code}
            onChange={handleInputChange}
            placeholder={
              "e.g.,\nfunction processUserData(data) {\n  // TODO: Add validation\n  database.save(data);\n  return true;\n}"
            }
            className="workflow-input workflow-textarea"
            rows={4}
          />
          <small className="input-help">
            Enter code snippet for parallel security, performance, and
            maintainability review
          </small>
        </div>
      );
    }

    if (type === "orchestrator") {
      const state = formState as FormState["orchestrator"];
      return (
        <div className="form-group">
          <label htmlFor="orchestrator-request">Feature Request</label>
          <textarea
            id="orchestrator-request"
            name="featureRequest"
            value={state.featureRequest}
            onChange={handleInputChange}
            placeholder="e.g., 'Add dark mode support to the dashboard, including theme persistence and system preference detection'"
            className="workflow-input workflow-textarea"
            rows={4}
          />
          <small className="input-help">
            Describe the feature to be implemented across multiple files
          </small>
        </div>
      );
    }

    if (type === "evaluator") {
      const state = formState as FormState["evaluator"];
      return (
        <>
          <div className="form-group">
            <label htmlFor="evaluator-text">Text to Translate</label>
            <textarea
              id="evaluator-text"
              name="text"
              value={state.text}
              onChange={handleInputChange}
              placeholder="e.g., 'The early bird catches the worm'"
              className="workflow-input workflow-textarea"
              rows={4}
            />
            <small className="input-help">
              Enter text to be translated and optimized
            </small>
          </div>
          <div className="form-group">
            <label htmlFor="evaluator-language">Target Language</label>
            <select
              id="evaluator-language"
              name="targetLanguage"
              value={state.targetLanguage}
              onChange={handleInputChange}
              className="workflow-input"
            >
              {LANGUAGES.map((lang) => (
                <option key={lang.value} value={lang.value}>
                  {lang.label}
                </option>
              ))}
            </select>
            <small className="input-help">
              Select the language to translate into
            </small>
          </div>
        </>
      );
    }
  };

  const formatOutput = (output: string) => {
    try {
      // Try to parse as JSON first
      const parsed = JSON.parse(output);
      return JSON.stringify(parsed, null, 2);
    } catch {
      // If not JSON, return as is
      return output;
    }
  };

  const runWorkflow = async () => {
    setWorkflowStatus((prev) => ({ ...prev, isRunning: true }));

    try {
      socket.send(
        JSON.stringify({
          input: formState,
          type: "run"
        })
      );
      // Show success toast when workflow starts
      const event = new CustomEvent("showToast", {
        detail: { message: `Started ${title} workflow...`, type: "info" }
      });
      window.dispatchEvent(event);
    } catch (_error) {
      // Show error toast if something goes wrong
      const event = new CustomEvent("showToast", {
        detail: { message: `Failed to start ${title} workflow`, type: "error" }
      });
      window.dispatchEvent(event);
    }
  };

  return (
    <section className="pattern-section">
      <h2>
        {index + 1}. {title}
      </h2>
      <div className="pattern-content">
        <div className="tab-container">
          <div className="tab-buttons">
            <button
              type="button"
              className={`tab-button ${
                activeTab === "diagram" ? "active" : ""
              }`}
              onClick={() => setActiveTab("diagram")}
            >
              Diagram
            </button>
            <button
              type="button"
              className={`tab-button ${activeTab === "code" ? "active" : ""}`}
              onClick={() => setActiveTab("code")}
            >
              Code
            </button>
          </div>
          <div className="tab-content">
            <div
              className={`tab-pane ${activeTab === "diagram" ? "active" : ""}`}
            >
              <div className="pattern-image">
                <img src={image} alt={`${title} workflow diagram`} />
              </div>
            </div>
            <div className={`tab-pane ${activeTab === "code" ? "active" : ""}`}>
              <div className="code-tab-container">
                <div
                  className={`code-content ${isCodeExpanded ? "expanded" : ""}`}
                >
                  {code}
                </div>
                <button
                  type="button"
                  className="expand-button"
                  onClick={() => setIsCodeExpanded(!isCodeExpanded)}
                >
                  {isCodeExpanded ? "Collapse" : "Expand"}
                  <span className={`icon ${isCodeExpanded ? "expanded" : ""}`}>
                    ▼
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
        <p className="pattern-description">{description}</p>
        <div className="workflow-runner">
          <div className="workflow-form">{getFormContent()}</div>
          <div className="workflow-toolbar">
            <button
              type="button"
              className="run-button"
              onClick={runWorkflow}
              disabled={workflowStatus.isRunning}
            >
              {workflowStatus.isRunning ? (
                <>
                  <div className="spinner" />
                  Running...
                </>
              ) : workflowStatus.output ? (
                "Run Again"
              ) : (
                "Run"
              )}
            </button>
            {/* {workflowState.isRunning && (
              <button
                className="stop-button"
                onClick={() => {
                  socket.send(JSON.stringify({ type: "stop" }));
                  const event = new CustomEvent("showToast", {
                    detail: {
                      type: "info",
                      message: `Stopping ${title} workflow...`,
                    },
                  });
                  window.dispatchEvent(event);
                }}
              >
                Stop
              </button>
            )} */}
          </div>
          <pre className="workflow-output">
            {workflowStatus.output
              ? formatOutput(workflowStatus.output)
              : `Enter input above and click 'Run' to see ${title} in action`}
          </pre>
        </div>
      </div>
    </section>
  );
}

export default function App() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const sessionId = useMemo(() => getOrCreateSessionId(), []);

  const addToast = useCallback((type: ToastType, message: string) => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);

  const removeToast = (id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  };

  useEffect(() => {
    // Theme detection code
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)"
    ).matches;
    setTheme(prefersDark ? "dark" : "light");
    document.documentElement.setAttribute(
      "data-theme",
      prefersDark ? "dark" : "light"
    );

    // Add toast event listener
    const handleToast = (
      e: CustomEvent<{ type: ToastType; message: string }>
    ) => {
      addToast(e.detail.type, e.detail.message);
    };

    window.addEventListener("showToast", handleToast as EventListener);

    return () => {
      window.removeEventListener("showToast", handleToast as EventListener);
    };
  }, [addToast]);

  const toggleTheme = () => {
    const newTheme = theme === "light" ? "dark" : "light";
    setTheme(newTheme);
    document.documentElement.setAttribute("data-theme", newTheme);
  };

  const patterns = {
    evaluator: {
      code: evaluatorCode,
      description:
        "One LLM generates responses while another provides evaluation and feedback in a loop.",
      image: "/flows/05 evaluator.png",
      title: "Evaluator-Optimizer"
    },
    orchestrator: {
      code: orchestratorCode,
      description:
        "A central LLM dynamically breaks down tasks, delegates to worker LLMs, and synthesizes results.",
      image: "/flows/04 orchestrator.png",
      title: "Orchestrator-Workers"
    },
    parallel: {
      code: parallelCode,
      description:
        "Enables simultaneous task processing through sectioning or voting mechanisms.",
      image: "/flows/03 parallel.png",
      title: "Parallelization"
    },
    routing: {
      code: routingCode,
      description:
        "Classifies input and directs it to specialized followup tasks, allowing for separation of concerns.",
      image: "/flows/02 routing.png",
      title: "Routing"
    },
    sequential: {
      code: sequentialCode,
      description:
        "Decomposes tasks into a sequence of steps, where each LLM call processes the output of the previous one.",
      image: "/flows/01 sequential.png",
      title: "Prompt Chaining"
    }
  };

  return (
    <div className="container">
      <ToastContainer toasts={toasts} onClose={removeToast} />
      <header>
        {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- theme toggle */}
        <div className="theme-toggle" onClick={toggleTheme}>
          <span className="theme-toggle-icon">
            {theme === "light" ? "🌞" : "🌙"}
          </span>
          <div className="theme-toggle-switch" />
        </div>
        <h1>⛅️ Building Effective Agents</h1>
        <p>Common patterns for implementing AI agents</p>
        <div className="header-links">
          <p>
            Based on{" "}
            <a
              href="https://www.anthropic.com/research/building-effective-agents"
              target="_blank"
              rel="noopener noreferrer"
            >
              Anthropic's research
            </a>{" "}
            on agent patterns.
          </p>
          <p>
            Code samples from{" "}
            <a
              href="https://sdk.vercel.ai/docs/foundations/agents"
              target="_blank"
              rel="noopener noreferrer"
            >
              AI SDK
            </a>
            , running on{" "}
            <a
              href="https://github.com/cloudflare/agents"
              target="_blank"
              rel="noopener noreferrer"
            >
              Cloudflare Agents
            </a>
            .
          </p>
        </div>
      </header>

      <main>
        {(
          Object.entries(patterns) as [
            WorkflowType,
            (typeof patterns)[keyof typeof patterns]
          ][]
        ).map(([type, pattern], index) => (
          <PatternSection
            key={type}
            type={type}
            title={pattern.title}
            description={pattern.description}
            image={pattern.image}
            code={pattern.code}
            index={index}
            sessionId={sessionId}
          />
        ))}
      </main>

      <section className="durable-objects-intro">
        <h2>Why Durable Objects?</h2>
        <p>
          Cloudflare's Durable Objects provide the perfect environment for
          hosting AI agents:
        </p>

        <div className="benefits-grid">
          <div className="benefit-card">
            <h3>Persistent State</h3>
            <p>
              Agents continue running even when browser tabs are closed or
              refreshed, maintaining their state and context throughout
              long-running tasks.
            </p>
          </div>

          <div className="benefit-card">
            <h3>Real-time Updates</h3>
            <p>
              WebSocket connections enable live streaming of agent progress,
              thoughts, and results directly to any connected client, providing
              immediate feedback.
            </p>
          </div>

          <div className="benefit-card">
            <h3>Global Scale</h3>
            <p>
              Agents run at the edge, automatically scaling across Cloudflare's
              worldwide network, ensuring low-latency responses regardless of
              user location.
            </p>
          </div>

          <div className="benefit-card">
            <h3>Flexible Triggers</h3>
            <p>
              Agents can be activated through various means: HTTP requests,
              scheduled cron jobs, email handlers, or other server-side events.
            </p>
          </div>

          <div className="benefit-card">
            <h3>Memory Isolation</h3>
            <p>
              Each agent runs in its own isolated environment, preventing
              resource contention and ensuring reliable performance.
            </p>
          </div>

          <div className="benefit-card">
            <h3>Cost Effective</h3>
            <p>
              Pay only for the compute time your agents use, with no idle costs
              and automatic scaling based on demand.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
