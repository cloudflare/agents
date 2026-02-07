import type { RealtimeItem } from "@openai/agents/realtime";
import { useAgent } from "agents/react";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

interface Message {
  itemId: string;
  type: string;
  role: "user" | "assistant";
  status: "completed" | "in_progress";
  content: Array<{
    type: string;
    transcript: string;
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- OpenAI SDK audio type not exposed
    audio?: any;
  }>;
}

function App() {
  const [state, setState] = useState<{ history: RealtimeItem[] }>({
    history: []
  });
  const [callStatus, setCallStatus] = useState<
    "connecting" | "connected" | "disconnected"
  >("connecting");
  const [callDuration, setCallDuration] = useState(0);

  useAgent<{ history: RealtimeItem[] }>({
    agent: "my-agent",
    name: "123",
    onStateUpdate(newState) {
      setState(newState);
      // Update call status based on state
      if (newState.history && newState.history.length > 0) {
        setCallStatus("connected");
      }
    }
  });

  // Timer for call duration
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (callStatus === "connected") {
      interval = setInterval(() => {
        setCallDuration((prev) => prev + 1);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [callStatus]);

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed":
        return "#22c55e";
      case "in_progress":
        return "#f59e0b";
      default:
        return "#6b7280";
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case "completed":
        return "✓";
      case "in_progress":
        return "●";
      default:
        return "○";
    }
  };

  return (
    <div className="phone-call-container">
      {/* Call Header */}
      <div className="call-header">
        <div className="call-info">
          <div className="call-title">Live Call Transcription</div>
          <div className="call-duration">{formatDuration(callDuration)}</div>
        </div>
        <div className="call-status">
          <div className={`status-indicator ${callStatus}`}>
            <div className="status-dot" />
            <span>
              {callStatus.charAt(0).toUpperCase() + callStatus.slice(1)}
            </span>
          </div>
        </div>
      </div>

      {/* Transcription Area */}
      <div className="transcription-area">
        {!state.history || state.history.length === 0 ? (
          <div className="no-messages">
            <div className="waiting-indicator">
              <div className="pulse-dot" />
              <p>Waiting for call to begin...</p>
            </div>
          </div>
        ) : (
          <div className="messages-container">
            {state.history.map((item: RealtimeItem, _index) => {
              const message = item as Message;
              const isUser = message.role === "user";
              const transcript = message.content?.[0]?.transcript || "";

              return (
                <div
                  key={message.itemId}
                  className={`message-bubble ${isUser ? "user" : "assistant"} ${
                    message.status
                  }`}
                >
                  <div className="message-header">
                    <span className="speaker-name">
                      {isUser ? "You" : "Agent"}
                    </span>
                    <span
                      className="status-indicator"
                      style={{ color: getStatusColor(message.status) }}
                    >
                      {getStatusText(message.status)}
                    </span>
                  </div>
                  <div className="message-content">
                    {transcript || "Processing..."}
                  </div>
                  {message.status === "in_progress" && (
                    <div className="typing-indicator">
                      <span />
                      <span />
                      <span />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Call Controls */}
      <div className="call-controls">
        <button type="button" className="control-btn mute-btn">
          <span>🔇</span>
        </button>
        <button type="button" className="control-btn end-call-btn">
          <span>📞</span>
        </button>
        <button type="button" className="control-btn speaker-btn">
          <span>🔊</span>
        </button>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
