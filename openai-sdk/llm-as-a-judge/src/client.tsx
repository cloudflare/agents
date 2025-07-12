import { useAgent } from "agents/react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Attempt, CFAgentState, MyAgent } from "./server";

function App() {
  const [description, setDescription] = useState<string>("");
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [status, setStatus] = useState<string>();
  const [chosenSlogan, setChosenSlogan] = useState<string>();
  const [attemptsExpanded, setAttemptsExpanded] = useState<boolean>(false);

  console.log("[Client] Current description:", description);

  const agent = useAgent<MyAgent, CFAgentState>({
    agent: "my-agent",
    name: "slogan-generator",
    onStateUpdate(state, source) {
      console.log("[Client] onStateUpdate called ", source);
      setAttempts(state.attempts);
      setChosenSlogan(state.chosenSlogan);
      setStatus(state.status);
    }
  });

  const handleGenerate = async () => {
    if (description) {
      console.log("[Client] Using agent stup to generate slogan:", description);
      await agent.stub.generateSlogan(description);
    } else {
      console.log(
        "[Client] Attempted to generateSlogan with empty description"
      );
    }
  };

  const handleDescriptionChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newDescription = e.target.value;
    console.log("[Client] Description input changed:", newDescription);
    setDescription(newDescription);
    if (attempts.length > 0) {
      // Reset the run
      agent.stub.reset();
    }
  };

  return (
    <div style={{ fontFamily: "Arial, sans-serif", padding: "20px" }}>
      <h1 style={{ color: "#333", marginBottom: "20px" }}>LLM As a Judge</h1>

      <div style={{ marginBottom: "20px" }}>
        <input
          type="text"
          value={description || ""}
          onChange={handleDescriptionChange}
          placeholder="Describe your product..."
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
          onClick={handleGenerate}
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
          Generate Slogan
        </button>
      </div>

      {status && <div>{status}</div>}

      {chosenSlogan && (
        <div
          style={{
            backgroundColor: "#f8f9fa",
            border: "3px solid #28a745",
            borderRadius: "12px",
            padding: "24px",
            margin: "20px 0",
            textAlign: "center",
            boxShadow: "0 8px 16px rgba(0,0,0,0.1)",
            background: "linear-gradient(135deg, #e3f2fd 0%, #f3e5f5 100%)"
          }}
        >
          <h2
            style={{
              color: "#2c3e50",
              fontSize: "28px",
              fontWeight: "bold",
              margin: "0",
              textShadow: "2px 2px 4px rgba(0,0,0,0.1)"
            }}
          >
            🎯 {chosenSlogan}
          </h2>
          <p
            style={{
              color: "#34495e",
              fontSize: "16px",
              fontStyle: "italic",
              margin: "8px 0 0 0"
            }}
          >
            Selected Winner
          </p>
        </div>
      )}

      {attempts.length > 0 && (
        <div style={{ marginTop: "20px" }}>
          <button
            type="button"
            onClick={() => setAttemptsExpanded(!attemptsExpanded)}
            style={{
              backgroundColor: "#6c757d",
              border: "none",
              borderRadius: "6px",
              color: "white",
              cursor: "pointer",
              fontSize: "14px",
              padding: "8px 16px",
              marginBottom: "10px",
              display: "flex",
              alignItems: "center",
              gap: "8px"
            }}
          >
            {attemptsExpanded ? "▼" : "▶"}
            View All Attempts ({attempts.length})
          </button>

          {attemptsExpanded && (
            <div
              style={{
                backgroundColor: "#f8f9fa",
                border: "1px solid #dee2e6",
                borderRadius: "8px",
                padding: "16px",
                maxHeight: "400px",
                overflowY: "auto"
              }}
            >
              {attempts.map((attempt) => (
                <div
                  key={attempt.slogan}
                  style={{
                    backgroundColor: "white",
                    border: "1px solid #e9ecef",
                    borderRadius: "6px",
                    padding: "12px",
                    marginBottom: "8px",
                    boxShadow: "0 2px 4px rgba(0,0,0,0.05)"
                  }}
                >
                  <div
                    style={{
                      fontWeight: "bold",
                      color: "#495057",
                      marginBottom: "4px"
                    }}
                  >
                    Slogan: {attempt.slogan}
                  </div>
                  <div
                    style={{
                      color: "#6c757d",
                      fontSize: "14px",
                      marginBottom: "4px"
                    }}
                  >
                    Score:{" "}
                    <span
                      style={{
                        fontWeight: "bold",
                        color:
                          attempt.score === "pass"
                            ? "#28a745"
                            : attempt.score === "needs_improvement"
                              ? "#ffc107"
                              : "#dc3545"
                      }}
                    >
                      {attempt.score}
                    </span>
                  </div>
                  <div
                    style={{
                      color: "#6c757d",
                      fontSize: "14px",
                      fontStyle: "italic"
                    }}
                  >
                    Feedback: {attempt.feedback}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

console.log("[Client] Initializing React app");
const root = createRoot(document.getElementById("root")!);
root.render(<App />);
