import type { Message } from "../types";

interface ChatMessageProps {
  message: Message;
}

function tryPrettyJSON(maybeJSON: string): string {
  if (typeof maybeJSON !== "string") {
    try {
      return JSON.stringify(maybeJSON, null, 2);
    } catch {
      return String(maybeJSON == null ? "" : maybeJSON);
    }
  }
  try {
    return JSON.stringify(JSON.parse(maybeJSON), null, 2);
  } catch {
    return maybeJSON.trim();
  }
}

export function ChatMessage({ message }: ChatMessageProps) {
  const { role, content } = message;

  // Handle system messages differently
  if (role === "system") {
    return (
      <div style={{ display: "flex", justifyContent: "center", width: "100%" }}>
        <div
          style={{
            padding: "0.5lh 1ch",
            fontSize: "0.9em",
            opacity: 0.8,
            textAlign: "center"
          }}
        >
          <span is-="badge" variant-="background0">
            {content}
          </span>
        </div>
      </div>
    );
  }

  const name = role === "user" ? "You" : "AI";
  const position = role === "user" ? "flex-end" : "flex-start";

  return (
    <div style={{ display: "flex", justifyContent: position }}>
      <div className={`message ${role}`} box-="round" shear-="both">
        <div className="message-content">{tryPrettyJSON(content)}</div>
        <div className="header" style={{ justifyContent: position }}>
          <span is-="badge">{name}</span>
        </div>
      </div>
    </div>
  );
}
