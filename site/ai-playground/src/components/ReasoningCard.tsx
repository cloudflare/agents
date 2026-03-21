import { useState } from "react";
import { CaretDownIcon } from "@phosphor-icons/react";
import { Streamdown } from "streamdown";

interface ReasoningCardProps {
  part: {
    type: "reasoning";
    text: string;
    state?: "streaming" | "done";
  };
  isStreaming?: boolean;
}

export const ReasoningCard = ({
  part,
  isStreaming = false
}: ReasoningCardProps) => {
  const [isExpanded, setIsExpanded] = useState(true);

  // Scroll to bottom on every render while streaming by using a ref callback.
  // The callback fires whenever the sentinel element mounts or its key changes,
  // which happens on each re-render caused by new text arriving.
  const scrollToBottom = (el: HTMLDivElement | null) => {
    if (el && isStreaming) {
      el.scrollIntoView({ block: "end" });
    }
  };

  return (
    <div className="bg-purple-500/10 rounded-lg p-3 border border-purple-500/20">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 cursor-pointer"
      >
        <div className="w-2 h-2 rounded-full bg-purple-400" />
        <span className="font-semibold text-sm text-kumo-default">
          Reasoning
        </span>
        {part.state === "done" && (
          <span className="text-xs text-kumo-success">✓ Complete</span>
        )}
        {part.state === "streaming" && (
          <span className="text-xs text-kumo-brand">Thinking...</span>
        )}
        <CaretDownIcon
          size={16}
          className={`ml-auto text-kumo-secondary transition-transform ${
            isExpanded ? "rotate-180" : ""
          }`}
        />
      </button>

      <div
        className={`transition-all duration-200 overflow-hidden ${
          isExpanded ? "max-h-96 opacity-100 mt-3" : "max-h-0 opacity-0"
        }`}
      >
        <div className="bg-kumo-control rounded p-2 text-sm overflow-auto max-h-64 whitespace-pre-wrap text-kumo-default">
          <Streamdown className="sd-theme" controls={false} isAnimating={isStreaming}>
            {part.text}
          </Streamdown>
          {isStreaming && <div key={part.text.length} ref={scrollToBottom} />}
        </div>
      </div>
    </div>
  );
};
