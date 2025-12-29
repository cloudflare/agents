import { useState } from "react";

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
    // biome-ignore lint/a11y/noStaticElementInteractions: it's fine
    <div
      className="relative group"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {description && (
        <div className="text-xs text-gray-500 mb-1">{description}</div>
      )}
      <div className="relative bg-gray-100 rounded-sm py-3 px-3 pr-12 hover:bg-gray-200 transition-colors">
        <code className="text-sm font-mono text-gray-800">{command}</code>
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
              : "bg-gray-700 text-white hover:bg-gray-800"
          }`}
          title={copied ? "Copied!" : "Copy to clipboard"}
        >
          {copied ? (
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <title>Copied</title>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          ) : (
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <title>Copy</title>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
};

export default ShellCommand;
