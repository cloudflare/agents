import React, { useState } from "react";

interface ConnectBoxProps {
  onConnect: (agentName: string) => void;
  status: string;
  initialAgentName?: string;
}

export function ConnectBox({
  onConnect,
  status,
  initialAgentName = ""
}: ConnectBoxProps) {
  const [agentName, setAgentName] = useState(initialAgentName);

  const handleConnect = () => {
    if (agentName.trim()) {
      onConnect(agentName.trim());
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleConnect();
    }
  };

  return (
    <div id="connect-box">
      <div box-="square" shear-="both">
        <div className="header">
          <span is-="badge" variant-="background0">
            Connect to Agent
          </span>
        </div>
        <div className="content">
          <p>Use an agent to explore your Identity Disks.</p>
          <div className="buttons">
            <label box-="round" shear-="top" style={{ flex: 1 }}>
              <div className="row">
                <span is-="badge" variant-="background0">
                  Agent name
                </span>
              </div>
              <input
                id="agent"
                placeholder="my-cool-agent"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                onKeyDown={handleKeyDown}
              />
            </label>
            <button id="connect-button" onClick={handleConnect}>
              Connect
            </button>
          </div>
        </div>
        <div id="header">
          <span id="status" is-="badge" variant-="background0">
            {status}
          </span>
        </div>
      </div>
    </div>
  );
}
