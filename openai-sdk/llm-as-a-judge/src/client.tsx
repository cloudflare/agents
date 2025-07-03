import { useAgent } from "agents/react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Attempt, CFAgentState, MyAgent } from "./server";

function App() {

  const [description, setDescription] = useState<string>("");
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [chosenSlogan, setChosenSlogan] = useState<string>();

  console.log("[Client] Current description:", description);

  const agent = useAgent<MyAgent, CFAgentState>({
    agent: "my-agent",
    name: "slogan-generator",
    onStateUpdate(state) {
      console.log("[Client] onStateUpdate called");
      setAttempts(state.attempts);
      setChosenSlogan(state.chosenSlogan);
    },
  });

  const handleGenerate = async () => {
    if (description) {
      console.log("[Client] Sending description to agent:", description);
      await agent.stub.generateSlogan(description);
    } else {
      console.log("[Client] Attempted to generateSlogan with empty description");
    }
  };

  const handleDescriptionChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newDescription = e.target.value;
    console.log("[Client] Description input changed:", newDescription);
    setDescription(newDescription);
  };

  return (
    <div style={{ fontFamily: "Arial, sans-serif", padding: "20px" }}>
      <h1 style={{ color: "#333", marginBottom: "20px" }}>
        LLM As a Judge
      </h1>

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
            width: "300px",
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
            padding: "8px 16px",
          }}
        >
          Generate Slogan
        </button>
      </div>

      {chosenSlogan && <h2>{chosenSlogan}</h2> }
      
      {attempts.map((attempt, index) => (
        <div className="attempt">
          <div>Slogan: {attempt.slogan}</div>
          <div>Score: {attempt.score}</div>
          <div>Feedback: {attempt.feedback}</div>
        </div>
      ))}

      </div>
      
  );
}

console.log("[Client] Initializing React app");
const root = createRoot(document.getElementById("root")!);
root.render(<App />);
