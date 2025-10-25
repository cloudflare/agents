import { useState } from "react";

interface ToolCallCardProps {
  part: {
    type: string;
    state?: string;
    input: unknown;
    output?: unknown;
  };
}

export const ToolCallCard = ({ part }: ToolCallCardProps) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const toolName = part.type.replace("tool-", "");

  return (
    <div className="bg-orange-50 rounded-lg p-3 border border-orange-200">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 cursor-pointer"
      >
        <div className="w-2 h-2 rounded-full bg-orange-400" />
        <span className="font-semibold text-sm text-orange-900">
          {toolName}
        </span>
        {part.state === "output-available" && (
          <span className="text-xs text-orange-600">✓ Completed</span>
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
        <div className="mb-2">
          <div className="text-xs font-medium text-gray-600 mb-1">
            Arguments:
          </div>
          <pre className="bg-white rounded p-2 text-xs overflow-auto max-h-32">
            {JSON.stringify(part.input, null, 2)}
          </pre>
        </div>
        {part.state === "output-available" && (
          <div>
            <div className="text-xs font-medium text-gray-600 mb-1">
              Result:
            </div>
            <pre className="bg-white rounded p-2 text-xs overflow-auto max-h-32 whitespace-pre-wrap">
              {typeof part.output === "string"
                ? part.output
                : JSON.stringify(part.output, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
};
