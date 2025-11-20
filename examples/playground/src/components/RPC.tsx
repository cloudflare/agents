import { useAgent } from "agents/react";
import { useState } from "react";
import "./RPC.css";

export default function RPC({
  addToast
}: {
  addToast: (message: string, type: "success" | "error" | "info") => void;
}) {
  const [messages, setMessages] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const { call } = useAgent({ agent: "rpc" });

  const handleRegularCall = async () => {
    try {
      setLoading(true);
      const result = await call("test");
      addToast(`Regular RPC result: ${result}`, "success");
    } catch (error) {
      addToast(`Error: ${error}`, "error");
    } finally {
      setLoading(false);
    }
  };

  const handleStreamingCall = async () => {
    try {
      setLoading(true);
      setMessages([]);
      await call("testStreaming", [], {
        onChunk: (chunk: unknown) => {
          setMessages((prev) => [...prev, chunk as string]);
        }
      });
    } catch (error) {
      addToast(`Error: ${error}`, "error");
    } finally {
      setLoading(false);
    }
  };

  const handleDestroy = async () => {
    await call("destroyAgent");
    addToast("Agent destroyed", "success");
  };

  return (
    <div className="rpc-container">
      <div className="rpc-content">
        <div className="button-container">
          <button
            type="button"
            onClick={handleDestroy}
            disabled={loading}
            className="rpc-button button-destroy"
          >
            Destroy Agent
          </button>
          <button
            type="button"
            onClick={handleRegularCall}
            disabled={loading}
            className="rpc-button button-regular"
          >
            {loading ? (
              <span className="button-text">
                <svg
                  className="loading-spinner"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  role="img"
                  aria-label="Loading spinner"
                >
                  <title>Loading spinner</title>
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                Processing...
              </span>
            ) : (
              "Regular RPC Call"
            )}
          </button>
          <button
            type="button"
            onClick={handleStreamingCall}
            disabled={loading}
            className="rpc-button button-streaming"
          >
            {loading ? (
              <span className="button-text">
                <svg
                  className="loading-spinner"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  role="img"
                  aria-label="Loading spinner"
                >
                  <title>Loading spinner</title>
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                Streaming...
              </span>
            ) : (
              "Start Streaming"
            )}
          </button>
        </div>

        {messages.length > 0 && (
          <div className="messages-container">
            <div className="messages-header">
              <h3>Streaming Messages</h3>
            </div>
            <div className="messages-list">
              {messages.map((message, messageId) => (
                <div key={`message-${messageId}`} className="message-item">
                  <div className="message-content">
                    <div className="message-icon-container">
                      <svg
                        className="message-icon"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        role="img"
                        aria-label="Message icon"
                      >
                        <title>Message icon</title>
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M13 10V3L4 14h7v7l9-11h-7z"
                        />
                      </svg>
                    </div>
                    <div className="message-text">
                      <p className="message-main">{message}</p>
                      <p className="message-number">Message #{messageId + 1}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
