import { useState, useEffect } from "react";

export function useAgentName(): [string, (name: string) => void] {
  const [agentName, setAgentNameState] = useState<string>(
    localStorage.getItem("agentName") ?? ""
  );

  const setAgentName = (name: string) => {
    setAgentNameState(name);
    try {
      localStorage.setItem("agentName", name);
    } catch (e) {
      console.error("Error saving agent name to localStorage:", e);
    }
  };

  return [agentName, setAgentName];
}
