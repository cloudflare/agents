import { useState, useCallback, useEffect } from "react";
import type { Message } from "../types";

interface UseChatReturn {
  messages: Message[];
  sendMessage: (agentBase: string, content: string) => Promise<void>;
  clearChat: () => void;
  isLoading: boolean;
  addSystemMessage: (content: string) => void;
}

export function useChat(agentName: string): UseChatReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Load chat from sessionStorage
  useEffect(() => {
    if (!agentName) return;

    try {
      const stored = sessionStorage.getItem(`${agentName}-chat`);
      if (stored) {
        setMessages(JSON.parse(stored));
      } else {
        setMessages([]);
      }
    } catch (e) {
      console.error("Error loading chat:", e);
      setMessages([]);
    }
  }, [agentName]);

  // Save chat to sessionStorage whenever messages change
  useEffect(() => {
    if (!agentName) return;

    try {
      sessionStorage.setItem(`${agentName}-chat`, JSON.stringify(messages));
    } catch (e) {
      console.error("Error saving chat:", e);
    }
  }, [messages, agentName]);

  const sendMessage = useCallback(
    async (agentBase: string, content: string) => {
      if (!content.trim()) return;

      setIsLoading(true);
      const userMessage: Message = { role: "user", content };

      // Add user message immediately
      setMessages((prev) => [...prev, userMessage]);

      try {
        const allMessages = [...messages, userMessage];
        const res = await fetch(`${agentBase}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: allMessages })
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        let assistantText = "";

        // Handle streaming response
        if (res.body && res.body.getReader) {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            assistantText += decoder.decode(value, { stream: true });

            // Update the assistant message in real-time
            setMessages((prev) => {
              const lastMsg = prev[prev.length - 1];
              if (lastMsg && lastMsg.role === "assistant") {
                return [
                  ...prev.slice(0, -1),
                  { role: "assistant", content: assistantText }
                ];
              } else {
                return [...prev, { role: "assistant", content: assistantText }];
              }
            });
          }
        } else {
          // Fallback for non-streaming
          const ct = res.headers.get("content-type") || "";
          if (ct.includes("application/json")) {
            const json = await res.json();
            assistantText =
              json.text || json.message || JSON.stringify(json, null, 2);
          } else {
            assistantText = await res.text();
          }

          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: assistantText }
          ]);
        }
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `Error: ${errorMsg}` }
        ]);
      } finally {
        setIsLoading(false);
      }
    },
    [messages]
  );

  const clearChat = useCallback(() => {
    setMessages([]);
  }, []);

  const addSystemMessage = useCallback((content: string) => {
    setMessages((prev) => [...prev, { role: "system", content }]);
  }, []);

  return { messages, sendMessage, clearChat, isLoading, addSystemMessage };
}
