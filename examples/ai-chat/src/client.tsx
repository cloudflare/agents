import type React from "react";
import { Suspense, useState, useRef, useEffect, useCallback } from "react";
import { useAgent } from "agents/react";
import { useAgentChat, filesToParts } from "agents/ai-react";
import type { UIMessage, FileUIPart } from "ai";

type FilePreview = {
  file: File;
  previewUrl: string;
};

// Icons as simple SVG components
const SendIcon = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <line x1="22" y1="2" x2="11" y2="13" />
    <polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>
);

const AttachmentIcon = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);

const XIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const FileIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
);

const ImageIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <polyline points="21 15 16 10 5 21" />
  </svg>
);

function Chat() {
  const [isConnected, setIsConnected] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [files, setFiles] = useState<FilePreview[]>([]);

  const addFiles = useCallback((fileList: FileList) => {
    const newPreviews = Array.from(fileList).map((file) => ({
      file,
      previewUrl: file.type.startsWith("image/")
        ? URL.createObjectURL(file)
        : ""
    }));
    setFiles((prev) => [...prev, ...newPreviews]);
  }, []);

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => {
      const fp = prev[index];
      if (fp?.previewUrl) URL.revokeObjectURL(fp.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const clearFiles = useCallback(() => {
    setFiles((prev) => {
      for (const fp of prev) {
        if (fp.previewUrl) URL.revokeObjectURL(fp.previewUrl);
      }
      return [];
    });
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const fp of files) {
        if (fp.previewUrl) URL.revokeObjectURL(fp.previewUrl);
      }
    };
  }, []);

  const agent = useAgent({
    agent: "ResumableStreamingChat",
    name: "demo",
    onOpen: () => {
      setIsConnected(true);
      setIsReconnecting(false);
    },
    onClose: () => {
      setIsConnected(false);
      setIsReconnecting(true);
    },
    onError: (error) => {
      console.error("WebSocket error:", error);
    }
  });

  const { messages, sendMessage, clearHistory, status } = useAgentChat({
    agent
  });

  const isStreaming = status === "streaming";

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      addFiles(e.target.files);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!input.trim() && files.length === 0) || isStreaming) return;

    const message = input;
    const fileArray = files.map((fp) => fp.file);

    setInput("");
    clearFiles();

    await sendMessage({
      text:
        message || (fileArray.length > 0 ? "Please describe this image" : ""),
      files: fileArray.length > 0 ? await filesToParts(fileArray) : undefined
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as React.FormEvent);
    }
  };

  const getMessageText = (message: UIMessage): string => {
    return message.parts
      .filter((part) => part.type === "text")
      .map((part) => (part as { type: "text"; text: string }).text)
      .join("");
  };

  const getFileParts = (message: UIMessage): FileUIPart[] => {
    return message.parts.filter(
      (part): part is FileUIPart => part.type === "file"
    );
  };

  const canSend =
    (input.trim() || files.length > 0) && isConnected && !isStreaming;

  return (
    <div className="chat-container">
      {/* Header */}
      <header className="chat-header">
        <div className="header-content">
          <div className="header-title">
            <h1>Chat</h1>
            <div
              className={`status-badge ${isConnected ? "connected" : "disconnected"}`}
            >
              <span className="status-dot" />
              {isConnected
                ? "Live"
                : isReconnecting
                  ? "Reconnecting..."
                  : "Offline"}
            </div>
          </div>
          <button
            type="button"
            onClick={clearHistory}
            className="clear-button"
            title="Clear conversation"
          >
            Clear
          </button>
        </div>
      </header>

      {/* Messages Area */}
      <main className="messages-container">
        {messages.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              <svg
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <h2>Start a conversation</h2>
            <p>Send a message or attach an image to begin.</p>
          </div>
        ) : (
          <div className="messages-list">
            {messages.map((message, index) => {
              const isUser = message.role === "user";
              const isLastAssistant =
                message.role === "assistant" && index === messages.length - 1;
              const text = getMessageText(message);
              const fileParts = getFileParts(message);

              return (
                <div
                  key={message.id}
                  className={`message-wrapper ${isUser ? "user" : "assistant"}`}
                >
                  <div className="message-bubble">
                    {/* File attachments */}
                    {fileParts.length > 0 && (
                      <div className="attachments">
                        {fileParts.map((file, fileIndex) => {
                          const isRemoved =
                            file.url?.startsWith("file:removed:");
                          const displayName =
                            file.filename ||
                            (isRemoved
                              ? file.url?.replace("file:removed:", "")
                              : "File");

                          if (isRemoved) {
                            return (
                              <div
                                key={fileIndex}
                                className="attachment-placeholder"
                              >
                                <ImageIcon />
                                <span>{displayName}</span>
                              </div>
                            );
                          }

                          if (file.mediaType?.startsWith("image/")) {
                            return (
                              <img
                                key={fileIndex}
                                src={file.url}
                                alt={file.filename || "Attached image"}
                                className="attachment-image"
                              />
                            );
                          }

                          return (
                            <div key={fileIndex} className="attachment-file">
                              <FileIcon />
                              <span>{displayName}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Message text */}
                    {text && (
                      <div className="message-text">
                        {text}
                        {isLastAssistant && isStreaming && (
                          <span className="cursor" />
                        )}
                      </div>
                    )}

                    {/* Streaming indicator for empty assistant message */}
                    {!text && isLastAssistant && isStreaming && (
                      <div className="typing-indicator">
                        <span />
                        <span />
                        <span />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        )}
      </main>

      {/* Input Area */}
      <footer className="input-container">
        {/* File previews */}
        {files.length > 0 && (
          <div className="file-previews">
            {files.map((fp, index) => (
              <div key={index} className="file-preview">
                {fp.previewUrl ? (
                  <img src={fp.previewUrl} alt={fp.file.name} />
                ) : (
                  <div className="file-preview-icon">
                    <FileIcon />
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => removeFile(index)}
                  className="remove-file"
                  title="Remove"
                >
                  <XIcon />
                </button>
              </div>
            ))}
          </div>
        )}

        <form onSubmit={handleSubmit} className="input-form">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            multiple
            className="hidden-input"
          />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={!isConnected || isStreaming}
            className="attach-button"
            title="Attach files"
          >
            <AttachmentIcon />
          </button>

          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Message..."
            disabled={!isConnected || isStreaming}
            rows={1}
            className="message-input"
          />

          <button
            type="submit"
            disabled={!canSend}
            className={`send-button ${canSend ? "active" : ""}`}
            title="Send message"
          >
            <SendIcon />
          </button>
        </form>
      </footer>

      <style>{`
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }

        .chat-container {
          display: flex;
          flex-direction: column;
          height: 100vh;
          background: #0a0a0a;
          color: #fafafa;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
        }

        /* Header */
        .chat-header {
          flex-shrink: 0;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(10, 10, 10, 0.8);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          position: sticky;
          top: 0;
          z-index: 10;
        }

        .header-content {
          max-width: 48rem;
          margin: 0 auto;
          padding: 1rem 1.5rem;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .header-title {
          display: flex;
          align-items: center;
          gap: 0.75rem;
        }

        .header-title h1 {
          font-size: 1.125rem;
          font-weight: 600;
          letter-spacing: -0.025em;
        }

        .status-badge {
          display: flex;
          align-items: center;
          gap: 0.375rem;
          padding: 0.25rem 0.625rem;
          border-radius: 9999px;
          font-size: 0.75rem;
          font-weight: 500;
          transition: all 0.2s ease;
        }

        .status-badge.connected {
          background: rgba(34, 197, 94, 0.1);
          color: #4ade80;
        }

        .status-badge.disconnected {
          background: rgba(239, 68, 68, 0.1);
          color: #f87171;
        }

        .status-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: currentColor;
          animation: pulse 2s ease-in-out infinite;
        }

        .clear-button {
          padding: 0.5rem 1rem;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 0.5rem;
          background: transparent;
          color: #a1a1aa;
          font-size: 0.875rem;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .clear-button:hover {
          background: rgba(255, 255, 255, 0.05);
          color: #fafafa;
          border-color: rgba(255, 255, 255, 0.2);
        }

        /* Messages */
        .messages-container {
          flex: 1;
          overflow-y: auto;
          overflow-x: hidden;
        }

        .empty-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100%;
          padding: 2rem;
          text-align: center;
          color: #71717a;
        }

        .empty-icon {
          margin-bottom: 1rem;
          opacity: 0.5;
        }

        .empty-state h2 {
          font-size: 1.125rem;
          font-weight: 600;
          color: #a1a1aa;
          margin-bottom: 0.5rem;
        }

        .empty-state p {
          font-size: 0.875rem;
        }

        .messages-list {
          max-width: 48rem;
          margin: 0 auto;
          padding: 1.5rem;
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }

        .message-wrapper {
          display: flex;
          animation: messageIn 0.2s ease-out;
        }

        .message-wrapper.user {
          justify-content: flex-end;
        }

        .message-wrapper.assistant {
          justify-content: flex-start;
        }

        .message-bubble {
          max-width: 80%;
          padding: 0.875rem 1rem;
          border-radius: 1.25rem;
          transition: all 0.15s ease;
        }

        .message-wrapper.user .message-bubble {
          background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
          color: white;
          border-bottom-right-radius: 0.375rem;
        }

        .message-wrapper.assistant .message-bubble {
          background: #18181b;
          color: #e4e4e7;
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-bottom-left-radius: 0.375rem;
        }

        .message-text {
          font-size: 0.9375rem;
          line-height: 1.6;
          white-space: pre-wrap;
          word-break: break-word;
        }

        /* Attachments in messages */
        .attachments {
          display: flex;
          flex-wrap: wrap;
          gap: 0.5rem;
          margin-bottom: 0.625rem;
        }

        .attachment-image {
          max-width: 240px;
          max-height: 240px;
          border-radius: 0.75rem;
          object-fit: cover;
        }

        .attachment-file,
        .attachment-placeholder {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.5rem 0.75rem;
          background: rgba(255, 255, 255, 0.1);
          border-radius: 0.5rem;
          font-size: 0.8125rem;
          opacity: 0.8;
        }

        .attachment-placeholder {
          font-style: italic;
          opacity: 0.6;
        }

        /* Cursor and typing */
        .cursor {
          display: inline-block;
          width: 2px;
          height: 1.1em;
          background: #3b82f6;
          margin-left: 2px;
          animation: blink 1s step-end infinite;
          vertical-align: text-bottom;
        }

        .typing-indicator {
          display: flex;
          gap: 4px;
          padding: 4px 0;
        }

        .typing-indicator span {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #52525b;
          animation: typing 1.4s ease-in-out infinite;
        }

        .typing-indicator span:nth-child(2) {
          animation-delay: 0.2s;
        }

        .typing-indicator span:nth-child(3) {
          animation-delay: 0.4s;
        }

        /* Input Area */
        .input-container {
          flex-shrink: 0;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(10, 10, 10, 0.8);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          padding: 1rem 1.5rem 1.5rem;
        }

        .file-previews {
          max-width: 48rem;
          margin: 0 auto 0.75rem;
          display: flex;
          flex-wrap: wrap;
          gap: 0.5rem;
        }

        .file-preview {
          position: relative;
          width: 64px;
          height: 64px;
          border-radius: 0.75rem;
          overflow: hidden;
          background: #18181b;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .file-preview img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .file-preview-icon {
          width: 100%;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #71717a;
        }

        .remove-file {
          position: absolute;
          top: 4px;
          right: 4px;
          width: 20px;
          height: 20px;
          border-radius: 50%;
          background: rgba(0, 0, 0, 0.7);
          border: none;
          color: white;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          opacity: 0;
          transition: opacity 0.15s ease;
        }

        .file-preview:hover .remove-file {
          opacity: 1;
        }

        .input-form {
          max-width: 48rem;
          margin: 0 auto;
          display: flex;
          align-items: flex-end;
          gap: 0.5rem;
          background: #18181b;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 1.5rem;
          padding: 0.5rem;
          transition: border-color 0.15s ease, box-shadow 0.15s ease;
        }

        .input-form:focus-within {
          border-color: rgba(59, 130, 246, 0.5);
          box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
        }

        .hidden-input {
          display: none;
        }

        .attach-button,
        .send-button {
          flex-shrink: 0;
          width: 40px;
          height: 40px;
          border-radius: 50%;
          border: none;
          background: transparent;
          color: #71717a;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.15s ease;
        }

        .attach-button:hover:not(:disabled) {
          background: rgba(255, 255, 255, 0.05);
          color: #a1a1aa;
        }

        .attach-button:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }

        .send-button {
          background: #27272a;
        }

        .send-button.active {
          background: #3b82f6;
          color: white;
        }

        .send-button.active:hover {
          background: #2563eb;
        }

        .send-button:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }

        .message-input {
          flex: 1;
          min-height: 40px;
          max-height: 200px;
          padding: 0.625rem 0.5rem;
          background: transparent;
          border: none;
          color: #fafafa;
          font-size: 0.9375rem;
          line-height: 1.5;
          resize: none;
          outline: none;
          font-family: inherit;
        }

        .message-input::placeholder {
          color: #52525b;
        }

        .message-input:disabled {
          opacity: 0.5;
        }

        /* Animations */
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }

        @keyframes blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }

        @keyframes typing {
          0%, 60%, 100% { transform: translateY(0); }
          30% { transform: translateY(-4px); }
        }

        @keyframes messageIn {
          from {
            opacity: 0;
            transform: translateY(8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        /* Scrollbar */
        .messages-container::-webkit-scrollbar {
          width: 6px;
        }

        .messages-container::-webkit-scrollbar-track {
          background: transparent;
        }

        .messages-container::-webkit-scrollbar-thumb {
          background: #27272a;
          border-radius: 3px;
        }

        .messages-container::-webkit-scrollbar-thumb:hover {
          background: #3f3f46;
        }

        /* Responsive */
        @media (max-width: 640px) {
          .header-content,
          .messages-list,
          .file-previews,
          .input-form {
            padding-left: 1rem;
            padding-right: 1rem;
          }

          .message-bubble {
            max-width: 90%;
          }

          .input-container {
            padding: 0.75rem 1rem 1rem;
          }
        }
      `}</style>
    </div>
  );
}

export default function App() {
  return (
    <Suspense
      fallback={
        <div
          style={{
            height: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#0a0a0a",
            color: "#71717a"
          }}
        >
          Loading...
        </div>
      }
    >
      <Chat />
    </Suspense>
  );
}
