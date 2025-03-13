import "./styles.css";
import { createRoot } from "react-dom/client";
import { useState, useEffect } from "react";
import { Scheduler } from "./components/Scheduler";
import { Stateful } from "./components/Stateful";
import Email from "./components/Email";
import Chat from "./components/Chat";
import RPC from "./components/RPC";

interface Toast {
  id: string;
  message: string;
  type: "success" | "error" | "info";
}

function Toast({
  message,
  type,
  onClose,
}: {
  message: string;
  type: "success" | "error" | "info";
  onClose: () => void;
}) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onClose();
    }, 3000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return <div className={`toast toast-${type}`}>{message}</div>;
}

function App() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = (
    message: string,
    type: "success" | "error" | "info" = "success"
  ) => {
    const newToast: Toast = {
      id: crypto.randomUUID(),
      message,
      type,
    };
    setToasts((prev) => [...prev, newToast]);
  };

  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  };

  return (
    <div className="container">
      <div className="toasts-container">
        {toasts.map((toast) => (
          <Toast
            key={toast.id}
            message={toast.message}
            type={toast.type}
            onClose={() => removeToast(toast.id)}
          />
        ))}
      </div>

      <div className="grid grid-cols-2 gap-8">
        <div className="col-span-1">
          <h2 className="text-xl font-bold mb-4">Scheduler</h2>
          <Scheduler addToast={addToast} />
        </div>
        <div className="col-span-1">
          <h2 className="text-xl font-bold mb-4">State Sync Demo</h2>
          <Stateful addToast={addToast} />
        </div>
        <div className="col-span-1">
          <h2 className="text-xl font-bold mb-4">Email (wip)</h2>
          <Email addToast={addToast} />
        </div>
        <div className="col-span-1">
          <h2 className="text-xl font-bold mb-4">Chat</h2>
          <Chat />
        </div>
        <div className="col-span-1">
          <h2 className="text-xl font-bold mb-4">RPC Demo</h2>
          <RPC addToast={addToast} />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
