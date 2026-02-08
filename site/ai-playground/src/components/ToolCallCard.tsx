import { useState } from "react";
import { CaretDownIcon } from "@phosphor-icons/react";

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
    <div className="bg-orange-500/10 rounded-lg p-3 border border-orange-500/20">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 cursor-pointer"
      >
        <div className="w-2 h-2 rounded-full bg-orange-400" />
        <span className="font-semibold text-sm text-kumo-default">
          {toolName}
        </span>
        {part.state === "output-available" && (
          <span className="text-xs text-kumo-success">✓ Completed</span>
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
        <div className="mb-2">
          <div className="text-xs font-medium text-kumo-secondary mb-1">
            Arguments:
          </div>
          <pre className="bg-kumo-control rounded p-2 text-xs overflow-auto max-h-32 text-kumo-default">
            {JSON.stringify(part.input, null, 2)}
          </pre>
        </div>
        {part.state === "output-available" && (
          <div>
            <div className="text-xs font-medium text-kumo-secondary mb-1">
              Result:
            </div>
            <pre className="bg-kumo-control rounded p-2 text-xs overflow-auto max-h-32 whitespace-pre-wrap text-kumo-default">
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
