import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode
} from "react";
import { nanoid } from "nanoid";
import { createElement } from "react";

export interface Toast {
  id: string;
  message: string;
  kind: "success" | "error" | "info";
}

interface ToastContextValue {
  toasts: Toast[];
  toast: (message: string, kind?: Toast["kind"]) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((message: string, kind: Toast["kind"] = "info") => {
    const id = nanoid();
    setToasts((prev) => [...prev.slice(-2), { id, message, kind }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }, []);

  return createElement(
    ToastContext.Provider,
    { value: { toasts, toast } },
    children
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}
