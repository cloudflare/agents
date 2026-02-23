import { useEffect, useState } from "react";
import { Surface, Text } from "@cloudflare/kumo";
import { CodeIcon } from "@phosphor-icons/react";
import { createHighlighter, type Highlighter } from "shiki";
import { useTheme } from "../hooks/useTheme";

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-light", "github-dark"],
      langs: ["typescript", "json"]
    });
  }
  return highlighterPromise;
}

export interface CodeSection {
  title: string;
  description: string;
  code: string;
}

interface CodeExplanationProps {
  sections: CodeSection[];
}

export function HighlightedCode({
  code,
  lang = "typescript"
}: {
  code: string;
  lang?: "typescript" | "json";
}) {
  const { resolvedMode } = useTheme();
  const theme = resolvedMode === "dark" ? "github-dark" : "github-light";
  const [html, setHtml] = useState("");

  useEffect(() => {
    let cancelled = false;
    getHighlighter().then((h) => {
      if (cancelled) return;
      setHtml(h.codeToHtml(code, { lang, theme }));
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang, theme]);

  if (!html) {
    return (
      <pre className="font-mono text-sm p-3 rounded-md bg-kumo-base border border-kumo-fill overflow-x-auto leading-relaxed">
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <div
      className="rounded-md overflow-x-auto text-sm [&_pre]:p-3 [&_pre]:!bg-kumo-base [&_pre]:!leading-relaxed border border-kumo-fill"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function HighlightedJson({ data }: { data: unknown }) {
  const code = JSON.stringify(data, null, 2);
  return <HighlightedCode code={code} lang="json" />;
}

export function CodeExplanation({ sections }: CodeExplanationProps) {
  return (
    <Surface className="rounded-lg ring ring-kumo-line mt-6">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-kumo-line">
        <CodeIcon size={18} className="text-kumo-subtle" />
        <Text variant="secondary" size="sm" bold>
          How it works
        </Text>
      </div>

      <div className="px-4 pb-4 space-y-6 pt-4">
        {sections.map((section, i) => (
          <div key={i}>
            <Text bold size="sm">
              {section.title}
            </Text>
            <p className="text-sm text-kumo-subtle mt-1 mb-3 leading-relaxed">
              {section.description}
            </p>
            <HighlightedCode code={section.code} />
          </div>
        ))}
      </div>
    </Surface>
  );
}
