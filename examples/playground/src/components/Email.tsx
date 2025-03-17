import { useAgentChat } from "agents/ai-react";
import { useAgent } from "agents/react";
import { useState, useEffect } from "react";
import type { Email as PostalEmail } from "postal-mime";
import "./Email.css";

interface Message {
  id: string;
  text: string;
  sender: "user" | "agent";
  timestamp: Date;
}

interface EmailProps {
  addToast: (message: string, type?: "success" | "error" | "info") => void;
}

export default function Email({ addToast }: EmailProps) {
  const agent = useAgent({
    agent: "email-agent",
  });
  const { messages, input, handleInputChange, handleSubmit, clearHistory } =
    useAgentChat({
      agent,
    });

  const [emails, setEmails] = useState<PostalEmail[]>([
    {
      messageId: "1",
      subject: "Welcome to the Email Agent",
      text: "Hello! This is your first email from the agent. You can reply to this email when chat is disconnected.",
      from: {
        name: "Agent",
        address: "agent@example.com",
      },
      headers: [],
      attachments: [],
      date: new Date().toISOString(),
    },
  ]);

  const mailboxAgent = useAgent({
    agent: "mock-email-service",
    onMessage(evt) {
      const msg = JSON.parse(evt.data);
      if (msg.type === "inbox:all") {
        setEmails(msg.messages);
      } else if (msg.type === "inbox:new-message") {
        const email = msg.message;
        setEmails((prev) => [...prev, email]);
      }
    },
  });

  // const [chatInput, setChatInput] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [isChatDisabled, setIsChatDisabled] = useState(false);

  // Show notification when chat is disabled
  useEffect(() => {
    if (isChatDisabled) {
      addToast("Chat is disabled. You can use email instead.", "info");

      // Add a system email notification when chat is disabled
      // const systemEmail: PostalEmail = {
      //   messageId: crypto.randomUUID(),
      //   subject: "Chat Disconnected",
      //   text: "The chat has been disconnected. You can continue the conversation via email.",
      //   from: {
      //     name: "Agent",
      //     address: "agent@example.com",
      //   },
      //   headers: [],
      //   attachments: [],
      //   date: new Date().toISOString(),
      // };
      // setEmails((prev) => [...prev, systemEmail]);
    }
  }, [isChatDisabled, addToast]);

  const sendChatMessage = (e: React.FormEvent) => {
    handleSubmit(e);
  };

  const sendEmail = (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailSubject.trim() || !emailBody.trim()) return;

    const newEmail: PostalEmail = {
      messageId: crypto.randomUUID(),
      subject: emailSubject,
      text: emailBody,
      from: {
        name: "User",
        address: "user",
      },
      headers: [],
      attachments: [],
      date: new Date().toISOString(),
    };

    setEmails((prev) => [...prev, newEmail]);
    mailboxAgent.send(
      JSON.stringify({
        type: "send-email",
        to: "theman@example.com",
        subject: emailSubject,
        text: emailBody,
      })
    );
    setEmailSubject("");
    setEmailBody("");
    addToast("Email sent successfully", "success");
  };

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  const clearChatMessages = () => {
    clearHistory();

    addToast("Chat history cleared", "info");
  };

  const clearEmails = () => {
    setEmails([]);
    mailboxAgent.send(
      JSON.stringify({
        type: "clear-emails",
      })
    );

    addToast("Email history cleared", "info");
  };

  return (
    <div className="email-container">
      <div className="email-grid">
        {/* Left side - Chat Window */}
        <div className="chat-section">
          <div className="section-header">
            <h3 className="section-title">Chat Window</h3>
            <div className="section-controls">
              <button
                type="button"
                onClick={clearChatMessages}
                className="clear-button"
                title="Clear chat history"
              >
                Clear
              </button>
              <div className="toggle-container">
                <label className="toggle-label">
                  <span>Disabled</span>
                  <input
                    type="checkbox"
                    checked={isChatDisabled}
                    onChange={() => setIsChatDisabled(!isChatDisabled)}
                    className="toggle-input"
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
            </div>
          </div>

          <div className="messages-container">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`message ${
                  message.role === "assistant"
                    ? "agent-message"
                    : "user-message"
                }`}
              >
                <div className="message-content">{message.content}</div>
                <div className="message-time">
                  {formatTime(new Date(message.createdAt as unknown as string))}
                </div>
              </div>
            ))}
          </div>

          <form onSubmit={sendChatMessage} className="input-form">
            <input
              type="text"
              value={input}
              onChange={handleInputChange}
              placeholder={
                isChatDisabled ? "Chat is disabled" : "Type a message..."
              }
              disabled={isChatDisabled}
              className="message-input"
            />
            <button
              type="submit"
              disabled={isChatDisabled || !input.trim()}
              className="send-button"
            >
              Send
            </button>
          </form>
        </div>

        {/* Right side - Email Chain */}
        <div className="email-section">
          <div className="section-header">
            <h3 className="section-title">Email Chain</h3>
            <div className="section-controls">
              <button
                type="button"
                onClick={clearEmails}
                className="clear-button"
                title="Clear email history"
              >
                Clear
              </button>
              <div className="email-hint">
                {isChatDisabled
                  ? "Chat is disabled. Use email instead."
                  : "Available when chat is disconnected"}
              </div>
            </div>
          </div>

          <div className="emails-container">
            {emails.map((email, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: vibes
                key={index}
                className={`email-item ${
                  email.from?.address === "agent" ? "agent-email" : "user-email"
                }`}
              >
                <div className="email-header">
                  <div className="email-subject">{email.subject}</div>
                  <div className="email-time">{email.date}</div>
                </div>
                <div className="email-body">{email.text}</div>
              </div>
            ))}
          </div>

          <form onSubmit={sendEmail} className="email-form">
            <input
              type="text"
              value={emailSubject}
              onChange={(e) => setEmailSubject(e.target.value)}
              placeholder="Email subject..."
              className="email-subject-input"
            />
            <textarea
              value={emailBody}
              onChange={(e) => setEmailBody(e.target.value)}
              placeholder="Email body..."
              className="email-body-input"
            />
            <button
              type="submit"
              disabled={!emailSubject.trim() || !emailBody.trim()}
              className="send-button"
            >
              Send Email
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
