import type { RealtimeItem } from "@openai/agents/realtime";
import { useAgent } from "agents/react";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

// const sampleData = {
//   history: [
//     {
//       itemId: "item_Bktz3NIfNof0qkoHp4vsQ",
//       previousItemId: null,
//       type: "message",
//       role: "user",
//       status: "completed",
//       content: [
//         {
//           type: "input_audio",
//           audio: null,
//           transcript: "Hello.",
//         },
//       ],
//     },
//     {
//       itemId: "item_Bktz5c8OSh4FnzIP4lqMy",
//       type: "message",
//       role: "assistant",
//       status: "in_progress",
//       content: [
//         {
//           type: "audio",
//           transcript:
//             "Hey there! How's it going? What can I help you with today?",
//           audio: null,
//         },
//       ],
//     },
//     {
//       itemId: "item_BktzC9GIiuC5FPzbAdXh6",
//       previousItemId: null,
//       type: "message",
//       role: "user",
//       status: "completed",
//       content: [
//         {
//           type: "input_audio",
//           audio: null,
//           transcript: "Just checking what's up with you.",
//         },
//       ],
//     },
//     {
//       itemId: "item_BktzFvEsntbZu6h1xsxCM",
//       type: "message",
//       role: "assistant",
//       status: "in_progress",
//       content: [
//         {
//           type: "audio",
//           transcript:
//             "I'm here and ready to assist with any questions or tasks you have. Feel free to ask away or let me know what you're curious about.",
//           audio: null,
//         },
//       ],
//     },
//   ],
// };

interface Message {
  itemId: string;
  type: string;
  role: "user" | "assistant";
  status: "completed" | "in_progress";
  content: Array<{
    type: string;
    transcript: string;
    // biome-ignore lint/suspicious/noExplicitAny: later
    audio?: any;
  }>;
}

function App() {
  const [state, setState] = useState<{ history: RealtimeItem[] }>({
    history: [],
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
    },
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
            <div className="status-dot"></div>
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
              <div className="pulse-dot"></div>
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
                      <span></span>
                      <span></span>
                      <span></span>
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
