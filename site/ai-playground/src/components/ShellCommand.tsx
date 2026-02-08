import { useState } from "react";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";

const ShellCommand = ({
  command,
  description
}: {
  command: string;
  description?: string;
}) => {
  const [copied, setCopied] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className="relative group"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {description && (
        <div className="text-xs text-kumo-secondary mb-1">{description}</div>
      )}
      <div className="relative bg-kumo-control rounded-md py-3 px-3 pr-12 hover:bg-kumo-tint transition-colors">
        <code className="text-sm font-mono text-kumo-default">{command}</code>
        <button
          type="button"
          onClick={handleCopy}
          className={`absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded transition-all ${
            isHovered || copied
              ? "opacity-100 translate-x-0"
              : "opacity-0 translate-x-2"
          } ${
            copied
              ? "bg-green-500 text-white"
              : "bg-kumo-inverse text-kumo-inverse hover:opacity-80"
          }`}
          title={copied ? "Copied!" : "Copy to clipboard"}
        >
          {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
        </button>
      </div>
    </div>
  );
};

export default ShellCommand;
