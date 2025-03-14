import { useAgent } from "agents-sdk/react";
import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import { agentFetch } from "agents-sdk/client";
import "./styles.css";
function App() {
  const [incomingMessages, setIncomingMessages] = useState<string[]>([]);
  const [outgoingMessages, setOutgoingMessages] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const agent = useAgent({
    agent: "my-agent",
    host: "http://localhost:8787",
    onMessage: (message) => {
      setIncomingMessages((prev) => [...prev, message.data as string]);
    },
  });
  return (
    <>
      <div>
        <form
          onSubmit={(e: React.FormEvent<HTMLFormElement>) => {
            if (!inputRef.current || !inputRef.current.value.trim()) return;
            e.preventDefault();
            const message = inputRef.current.value;
            agent.send(message);
            setOutgoingMessages((prev) => [...prev, message]);
            inputRef.current.value = "";
          }}
        >
          <input type="text" ref={inputRef} />
          <button type="submit">Send</button>
        </form>
      </div>
      <div>
        <h2>Incoming Messages</h2>
        {incomingMessages.map((message) => (
          <div key={message}>{message}</div>
        ))}
      </div>
      <div>
        <h2>Outgoing Messages</h2>
        {outgoingMessages.map((message) => (
          <div key={message}>{message}</div>
        ))}
      </div>
      <button
        type="button"
        onClick={async () => {
          try {
            const response = await agentFetch({
              agent: "my-agent",
              host: "http://localhost:8787",
            });
            const data = await response.text();
            console.log("from server:", data);
          } catch (error) {
            console.error("error fetching from server:", error);
          }
        }}
      >
        Send Request
      </button>
    </>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
