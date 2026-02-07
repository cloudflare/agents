import type { Agent, RunResult } from "@openai/agents";
import { useAgent } from "agents/react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentState, MyAgent } from "./server";

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- OpenAI SDK generic Agent type
type AppState = RunResult<unknown, Agent<unknown, any>> | null;

// Types for the agent state structure
interface ToolApprovalItem {
  type: "tool_approval_item";
  rawItem: {
    type: "function_call";
    id: string;
    callId: string;
    name: string;
    status: string;
    arguments: string;
    providerData: {
      id: string;
      type: "function_call";
    };
  };
  agent: {
    name: string;
  };
}

// Modal component for tool approval
function ApprovalModal({
  interruption,
  onApprove,
  onReject
}: {
  interruption: ToolApprovalItem;
  onApprove: () => void;
  onReject: () => void;
}) {
  const args = JSON.parse(interruption.rawItem.arguments);

  return (
    <div
      style={{
        alignItems: "center",
        backgroundColor: "rgba(0, 0, 0, 0.5)",
        bottom: 0,
        display: "flex",
        justifyContent: "center",
        left: 0,
        position: "fixed",
        right: 0,
        top: 0,
        zIndex: 1000
      }}
    >
      <div
        style={{
          backgroundColor: "white",
          borderRadius: "8px",
          boxShadow: "0 4px 6px rgba(0, 0, 0, 0.1)",
          maxWidth: "500px",
          padding: "24px",
          width: "90%"
        }}
      >
        <h2 style={{ color: "#333", marginTop: 0 }}>Tool Approval Required</h2>

        <div style={{ marginBottom: "16px" }}>
          <strong>Tool:</strong> {interruption.rawItem.name}
        </div>

        <div style={{ marginBottom: "16px" }}>
          <strong>Arguments:</strong>
          <pre
            style={{
              backgroundColor: "#f5f5f5",
              borderRadius: "4px",
              fontSize: "14px",
              overflow: "auto",
              padding: "8px"
            }}
          >
            {JSON.stringify(args, null, 2)}
          </pre>
        </div>

        <div style={{ marginBottom: "20px" }}>
          <strong>Agent:</strong> {interruption.agent.name}
        </div>

        <div
          style={{
            display: "flex",
            gap: "12px",
            justifyContent: "flex-end"
          }}
        >
          <button
            type="button"
            onClick={onReject}
            style={{
              backgroundColor: "white",
              border: "1px solid #dc3545",
              borderRadius: "4px",
              color: "#dc3545",
              cursor: "pointer",
              padding: "8px 16px"
            }}
          >
            Reject
          </button>
          <button
            type="button"
            onClick={onApprove}
            style={{
              backgroundColor: "#28a745",
              border: "1px solid #28a745",
              borderRadius: "4px",
              color: "white",
              cursor: "pointer",
              padding: "8px 16px"
            }}
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}

// Component to display agent state
// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- untyped agent state props
function AgentStateDisplay({ state }: any) {
  const hasInterruption = state.currentStep?.type === "next_step_interruption";
  const firstInterruption = hasInterruption
    ? state.currentStep.data?.interruptions[0]
    : null;

  return (
    <div style={{ marginTop: "20px" }}>
      <h3>Agent State</h3>

      <div style={{ marginBottom: "16px" }}>
        <strong>Current Agent:</strong> {state.currentAgent?.name || "Unknown"}
      </div>

      <div style={{ marginBottom: "16px" }}>
        <strong>Original Input:</strong> {state.originalInput || "None"}
      </div>

      <div style={{ marginBottom: "16px" }}>
        <strong>Current Step:</strong> {state.currentStep?.type || "Unknown"}
      </div>

      {state.currentStep?.type === "next_step_final_output" &&
        state.currentStep.output && (
          <div style={{ marginBottom: "16px" }}>
            <strong>Output:</strong>
            <div
              style={{
                backgroundColor: "#f8f9fa",
                border: "1px solid #dee2e6",
                borderRadius: "4px",
                padding: "12px",
                whiteSpace: "pre-wrap"
              }}
            >
              {state.currentStep.output}
            </div>
          </div>
        )}

      {state.lastProcessedResponse?.toolsUsed?.length > 0 && (
        <div style={{ marginBottom: "16px" }}>
          <strong>Tools Used:</strong>{" "}
          {state.lastProcessedResponse.toolsUsed.join(", ")}
        </div>
      )}

      {state.generatedItems?.length > 0 && (
        <div style={{ marginBottom: "16px" }}>
          <strong>Generated Items:</strong>
          <div
            style={{
              backgroundColor: "#f8f9fa",
              border: "1px solid #dee2e6",
              borderRadius: "4px",
              maxHeight: "200px",
              overflow: "auto",
              padding: "12px"
            }}
          >
            <pre style={{ fontSize: "12px", margin: 0 }}>
              {JSON.stringify(state.generatedItems, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {hasInterruption && firstInterruption && (
        <div
          style={{
            backgroundColor: "#fff3cd",
            border: "1px solid #ffeaa7",
            borderRadius: "4px",
            marginBottom: "16px",
            padding: "12px"
          }}
        >
          <strong>⚠️ Tool Approval Required</strong>
          <div>Tool: {firstInterruption.rawItem.name}</div>
          <div>Arguments: {firstInterruption.rawItem.arguments}</div>
        </div>
      )}
    </div>
  );
}

function App() {
  const [state, setState] = useState<AppState>(null);
  const [question, setQuestion] = useState<string | null>(null);
  const [showApprovalModal, setShowApprovalModal] = useState(false);
  const [currentInterruption, setCurrentInterruption] =
    useState<ToolApprovalItem | null>(null);

  console.log("[Client] App component rendered, current state:", state);
  console.log("[Client] Current question:", question);

  const agent = useAgent<MyAgent, AgentState>({
    agent: "my-agent",
    name: "weather-chat",
    onStateUpdate({
      serialisedRunState
    }: {
      serialisedRunState: string | null;
    }) {
      console.log("[Client] onStateUpdate called with serialisedRunState:");
      if (serialisedRunState) {
        const parsedState = JSON.parse(serialisedRunState) as AppState;
        console.log("[Client] Parsed state:", parsedState);
        setState(parsedState);

        // Check for interruptions - access the state property correctly
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic state shape from agent
        const agentState = parsedState as any;
        if (agentState?.currentStep?.type === "next_step_interruption") {
          const interruption = agentState.currentStep.data?.interruptions[0];
          if (interruption) {
            console.log("[Client] Found interruption:", interruption);
            setCurrentInterruption(interruption);
            setShowApprovalModal(true);
          }
        }
      } else {
        console.log("[Client] No serialisedRunState provided, clearing state");
        setState(null);
        setShowApprovalModal(false);
        setCurrentInterruption(null);
      }
    }
  });

  const handleAsk = () => {
    if (question) {
      console.log("[Client] Sending question to agent:", question);
      agent.stub.ask(question);
    } else {
      console.log("[Client] Attempted to ask empty question");
    }
  };

  const handleQuestionChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newQuestion = e.target.value;
    console.log("[Client] Question input changed:", newQuestion);
    setQuestion(newQuestion);
  };

  const handleApprove = () => {
    if (currentInterruption) {
      console.log(
        "[Client] Approving tool call:",
        currentInterruption.rawItem.callId
      );
      agent.stub.proceed(currentInterruption.rawItem.callId, true);
      setShowApprovalModal(false);
      setCurrentInterruption(null);
    }
  };

  const handleReject = () => {
    if (currentInterruption) {
      console.log(
        "[Client] Rejecting tool call:",
        currentInterruption.rawItem.callId
      );
      agent.stub.proceed(currentInterruption.rawItem.callId, false);
      setShowApprovalModal(false);
      setCurrentInterruption(null);
    }
  };

  // const handleCloseModal = () => {
  //   setShowApprovalModal(false);
  //   setCurrentInterruption(null);
  // };

  return (
    <div style={{ fontFamily: "Arial, sans-serif", padding: "20px" }}>
      <h1 style={{ color: "#333", marginBottom: "20px" }}>
        Weather Chat Agent
      </h1>

      <div style={{ marginBottom: "20px" }}>
        <input
          type="text"
          value={question || ""}
          onChange={handleQuestionChange}
          placeholder="Ask about the weather..."
          style={{
            border: "1px solid #ddd",
            borderRadius: "4px",
            fontSize: "16px",
            marginRight: "8px",
            padding: "8px 12px",
            width: "300px"
          }}
        />
        <button
          type="button"
          onClick={handleAsk}
          style={{
            backgroundColor: "#007bff",
            border: "none",
            borderRadius: "4px",
            color: "white",
            cursor: "pointer",
            fontSize: "16px",
            padding: "8px 16px"
          }}
        >
          Ask
        </button>
      </div>

      {/* oxlint-disable-next-line @typescript-eslint/no-explicit-any -- passing untyped state */}
      {state && <AgentStateDisplay state={state as any} />}

      {showApprovalModal && currentInterruption && (
        <ApprovalModal
          interruption={currentInterruption}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      )}
    </div>
  );
}

console.log("[Client] Initializing React app");
const root = createRoot(document.getElementById("root")!);
root.render(<App />);
