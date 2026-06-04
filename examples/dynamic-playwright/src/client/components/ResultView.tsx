import { useEffect, useState } from "react";
import { binaryToObjectUrl, isBinaryValue } from "../binary";

export function ResultView({ result }: { result: unknown }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isBinaryValue(result)) {
      setObjectUrl(null);
      return;
    }

    const nextUrl = binaryToObjectUrl(result);
    setObjectUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [result]);

  if (objectUrl) {
    return (
      <img
        src={objectUrl}
        alt="Script screenshot result"
        className="max-h-80 rounded-lg border border-kumo-line bg-kumo-base"
      />
    );
  }

  return (
    <pre className="font-mono text-xs text-kumo-subtle bg-kumo-elevated rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
      {JSON.stringify(result, null, 2)}
    </pre>
  );
}
