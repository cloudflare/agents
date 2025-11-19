import { useState } from "react";

interface ReasoningCardProps {
  part: {
    type: "reasoning";
    text: string;
    state?: "streaming" | "done";
  };
}

export const ReasoningCard = ({ part }: ReasoningCardProps) => {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <div className="bg-purple-50 rounded-lg p-3 border border-purple-200">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 cursor-pointer"
      >
        <div className="w-2 h-2 rounded-full bg-purple-400" />
        <span className="font-semibold text-sm text-purple-900">Reasoning</span>
        {part.state === "done" && (
          <span className="text-xs text-purple-600">✓ Complete</span>
        )}
        {part.state === "streaming" && (
          <span className="text-xs text-purple-600">Thinking...</span>
        )}
        <svg
          className={`ml-auto w-4 h-4 text-gray-600 transition-transform ${
            isExpanded ? "rotate-180" : ""
          }`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <title>Expand/collapse</title>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      <div
        className={`transition-all duration-200 overflow-hidden ${
          isExpanded ? "max-h-96 opacity-100 mt-3" : "max-h-0 opacity-0"
        }`}
      >
        <pre className="bg-white rounded p-2 text-sm overflow-auto max-h-64 whitespace-pre-wrap">
          {part.text}
        </pre>
      </div>
    </div>
  );
};
