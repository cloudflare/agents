import { createPortal } from "react-dom";
import { useToast } from "../hooks/useToast";
import {
  CheckCircleIcon,
  WarningCircleIcon,
  InfoIcon
} from "@phosphor-icons/react";

const ICONS = {
  success: <CheckCircleIcon size={16} className="text-kumo-success shrink-0" />,
  error: <WarningCircleIcon size={16} className="text-kumo-danger shrink-0" />,
  info: <InfoIcon size={16} className="text-kumo-info shrink-0" />
};

const BORDERS = {
  success: "border-green-500/30",
  error: "border-kumo-danger",
  info: "border-blue-500/30"
};

export function Toaster() {
  const { toasts } = useToast();

  if (toasts.length === 0) return null;

  return createPortal(
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2 max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`flex items-start gap-2 px-3 py-2 rounded-lg shadow-lg backdrop-blur-sm bg-kumo-elevated border ${BORDERS[t.kind]} animate-in fade-in slide-in-from-bottom-2 text-sm text-kumo-default`}
        >
          {ICONS[t.kind]}
          <span className="break-words">{t.message}</span>
        </div>
      ))}
    </div>,
    document.body
  );
}
