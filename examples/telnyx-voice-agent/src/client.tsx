import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useVoiceAgent, type VoiceStatus } from "@cloudflare/voice/react";
import "./styles.css";

function getSessionId(): string {
  const key = "telnyx-voice-agent-session-id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

function statusLabel(status: VoiceStatus): string {
  switch (status) {
    case "idle":
      return "Ready";
    case "listening":
      return "Listening";
    case "thinking":
      return "Thinking";
    case "speaking":
      return "Speaking";
  }
}

function App() {
  const sessionId = useRef(getSessionId()).current;
  const [text, setText] = useState("");

  const {
    status,
    transcript,
    interimTranscript,
    metrics,
    audioLevel,
    isMuted,
    connected,
    error,
    startCall,
    endCall,
    toggleMute,
    sendText
  } = useVoiceAgent({
    agent: "my-voice-agent",
    name: sessionId
  });

  const transcriptEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript, interimTranscript]);

  const inCall = status !== "idle";

  return (
    <main className="app">
      <section className="card hero">
        <p className="eyebrow">Cloudflare Agents + Telnyx</p>
        <h1>Telnyx Voice Agent</h1>
        <p>
          Talk to a Workers AI assistant using Telnyx speech-to-text and
          text-to-speech.
        </p>

        <div className="status-row">
          <span className={`dot ${connected ? "connected" : ""}`} />
          <span>{connected ? "Connected" : "Disconnected"}</span>
          <span className="pill">{statusLabel(status)}</span>
        </div>

        <div className="meter" aria-label="Audio level">
          <div style={{ width: `${Math.min(100, audioLevel * 200)}%` }} />
        </div>

        <div className="controls">
          {!inCall ? (
            <button className="primary" onClick={startCall}>
              Start talking
            </button>
          ) : (
            <button className="danger" onClick={endCall}>
              End call
            </button>
          )}
          <button disabled={!inCall} onClick={toggleMute}>
            {isMuted ? "Unmute" : "Mute"}
          </button>
        </div>

        {metrics ? (
          <p className="metrics">
            LLM {metrics.llm_ms}ms · TTS {metrics.tts_ms}ms · first audio{" "}
            {metrics.first_audio_ms}ms
          </p>
        ) : null}
        {error ? <p className="error">{error}</p> : null}
      </section>

      <section className="card transcript">
        <h2>Transcript</h2>
        <div className="messages">
          {transcript.length === 0 && !interimTranscript ? (
            <p className="empty">Start a call and say hello.</p>
          ) : null}
          {transcript.map((message, index) => (
            <article className={`message ${message.role}`} key={index}>
              <strong>{message.role === "user" ? "You" : "Assistant"}</strong>
              <span>{message.text}</span>
            </article>
          ))}
          {interimTranscript ? (
            <article className="message user interim">
              <strong>You</strong>
              <span>{interimTranscript}</span>
            </article>
          ) : null}
          <div ref={transcriptEndRef} />
        </div>

        <form
          className="text-form"
          onSubmit={(event) => {
            event.preventDefault();
            const value = text.trim();
            if (!value) return;
            sendText(value);
            setText("");
          }}
        >
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Or type a message..."
          />
          <button type="submit">Send</button>
        </form>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
