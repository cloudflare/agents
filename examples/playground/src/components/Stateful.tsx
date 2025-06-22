import { useAgent } from "agents/react";
import { useState } from "react";
import "./State.css";

interface StateProps {
  addToast: (message: string, type?: "success" | "error" | "info") => void;
}

interface State {
  counter: number;
  text: string;
  color: string;
  initialState: boolean;
}

// biome-ignore lint/correctness/noUnusedFunctionParameters: todo
export function Stateful({ addToast }: StateProps) {
  const [syncedState, setSyncedState] = useState<State>({
    color: "#3B82F6",
    counter: 0,
    initialState: true,
    text: "", // this gets wiped out by the server message
  });

  const agent = useAgent<State>({
    agent: "stateful",
    onStateUpdate: (state, _source: "server" | "client") => {
      setSyncedState(state);
    },
  });

  const handleIncrement = () => {
    const newCounter = syncedState.counter + 1;
    agent.setState({ ...syncedState, counter: newCounter });
  };

  const handleDecrement = () => {
    const newCounter = syncedState.counter - 1;
    agent.setState({ ...syncedState, counter: newCounter });
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newText = e.target.value;
    agent.setState({ ...syncedState, text: newText });
  };

  const handleColorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newColor = e.target.value;
    setSyncedState((state) => ({ ...state, color: newColor }));
    agent.setState({ ...syncedState, color: newColor });
  };

  return (
    <div className="state-container">
      <div className="state-grid">
        {!syncedState.initialState && (
          <>
            <div className="state-section">
              <h3 className="section-title">Counter</h3>
              <div className="counter-controls">
                <button
                  type="button"
                  onClick={handleDecrement}
                  className="counter-button counter-button-decrease"
                >
                  -
                </button>
                <span className="counter-value">{syncedState.counter}</span>
                <button
                  type="button"
                  onClick={handleIncrement}
                  className="counter-button counter-button-increase"
                >
                  +
                </button>
              </div>
            </div>

            <div className="state-section">
              <h3 className="section-title">Text Input</h3>
              <input
                type="text"
                value={syncedState.text}
                onChange={handleTextChange}
                className="state-input"
                placeholder="Type to sync..."
              />
            </div>

            <div className="state-section">
              <h3 className="section-title">Color Picker</h3>
              <div className="color-picker-container">
                <input
                  type="color"
                  value={syncedState.color}
                  onChange={handleColorChange}
                  className="color-picker"
                />
                <div
                  className="color-preview"
                  style={{ backgroundColor: syncedState.color }}
                />
              </div>
            </div>
          </>
        )}
      </div>

      <div className="state-hint">
        Open multiple windows to test state synchronization
      </div>
    </div>
  );
}
