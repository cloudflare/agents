// The "How it works" dialog: what the demo is, as a diagram, the code
// behind it, and the agent's tools in one line each.
import { Button, Dialog, Tabs } from "@cloudflare/kumo";
import {
  ArrowDownIcon,
  ArrowRightIcon,
  BrainIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CircleNotchIcon,
  CompassIcon,
  TerminalWindowIcon,
  XIcon
} from "@phosphor-icons/react";
import { useId, useState, type ReactNode } from "react";
import { CODE_STEPS } from "./about-code";
import { Markdown } from "./chat-ui";
import type { ToolInfo } from "./protocol";
import { DOCS_HOST, FILES_HOST, PREVIEW_HOST } from "./shared";

/** Each internal hostname: what serves it, what it reaches, and its target. */
export const HOSTS = [
  {
    host: PREVIEW_HOST,
    via: "Your agent's fetch",
    serves: "Dev server in the container",
    target: "{ port }"
  },
  {
    host: FILES_HOST,
    via: "Your agent's fetch",
    serves: "A workspace folder, e.g. dist",
    target: "{ folder }"
  },
  {
    host: DOCS_HOST,
    via: "A Worker, directly",
    serves: "Docs with build steps",
    target: null
  }
] as const;

/** One line per tool. The model sees the full descriptions. */
const TOOL_SUMMARIES: Record<string, string> = {
  exec: "Run a shell command in the container",
  read: "Read a file",
  write: "Write a file",
  edit: "Edit part of a file",
  delete: "Delete a file or folder",
  ls: "List a folder",
  find: "Find files by name",
  grep: "Search file contents"
};

/** The first sentence of a description, for tools without a summary. */
function firstSentence(description: string): string {
  return description.split(/(?<=\.)\s/)[0] ?? description;
}

export function HostChip({ host }: { host: string }) {
  return (
    <span className="inline-flex items-center rounded-md bg-kumo-tint px-1.5 py-0.5 font-mono text-xs text-kumo-default">
      {host}
    </span>
  );
}

function Box({
  icon,
  title,
  caption
}: {
  icon: ReactNode;
  title: string;
  caption: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-kumo-base px-3 py-2 ring-1 ring-kumo-line">
      <span className="text-kumo-brand">{icon}</span>
      <div className="flex flex-col">
        <span className="text-sm font-medium text-kumo-default">{title}</span>
        <span className="text-xs text-kumo-subtle">{caption}</span>
      </div>
    </div>
  );
}

function Arrow() {
  return (
    <span className="flex justify-center text-kumo-inactive" aria-hidden>
      <ArrowDownIcon size={14} className="sm:hidden" />
      <ArrowRightIcon size={14} className="hidden sm:block" />
    </span>
  );
}

/**
 * Agent → Browser → three internal hosts, each with what serves it, what it
 * reaches, and whether the model assigns it. One column on narrow screens, a
 * table on wide ones.
 */
function Diagram() {
  return (
    <figure
      aria-label="The agent drives a browser on Browser Run, which opens three internal hostnames"
      className="flex flex-col items-stretch gap-2 rounded-xl bg-kumo-elevated p-3 sm:flex-row sm:items-center"
    >
      <Box
        icon={<BrainIcon size={16} weight="duotone" />}
        title="Agent"
        caption="pi, workspace, browser tool"
      />
      <Arrow />
      <Box
        icon={<CompassIcon size={16} weight="duotone" />}
        title="Browser"
        caption="Browser Run, no internet"
      />
      <Arrow />
      <ul className="flex flex-col gap-1.5 lg:grid lg:grid-cols-[auto_auto_auto_auto] lg:items-center lg:gap-x-3 lg:gap-y-2">
        {HOSTS.map(({ host, via, serves, target }) => (
          <li key={host} className="flex flex-col gap-0.5 lg:contents">
            <HostChip host={host} />
            <span className="hidden items-center gap-1.5 text-xs text-kumo-subtle lg:flex">
              <ArrowRightIcon
                size={12}
                className="text-kumo-inactive"
                aria-hidden
              />
              {via}
            </span>
            <span className="pl-1.5 text-xs text-kumo-subtle lg:flex lg:items-center lg:gap-1.5 lg:pl-0">
              <ArrowRightIcon
                size={12}
                className="hidden text-kumo-inactive lg:block"
                aria-hidden
              />
              {serves}
            </span>
            <span className="pl-1.5 text-xs lg:pl-0">
              {target ? (
                <span className="text-kumo-default">
                  Model assigns <code className="font-mono">{target}</code>
                </span>
              ) : (
                <span className="text-kumo-subtle">Fixed</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-xs font-medium text-kumo-subtle">{children}</h3>;
}

function ToolName({ name, active }: { name: string; active: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      {active ? (
        <CircleNotchIcon
          size={12}
          className="animate-spin text-kumo-brand"
          aria-label="Running"
        />
      ) : null}
      <code className="font-mono text-xs font-medium text-kumo-default">
        {name}
      </code>
    </span>
  );
}

function CodeBlock({
  language,
  code,
  added = []
}: {
  language: string;
  code: string;
  /** 1-based lines to highlight as new. */
  added?: readonly number[];
}) {
  const id = useId().replace(/:/g, "");
  const lines = added.map((n) => `:nth-child(${n})`).join(", ");
  return (
    <div data-code={id}>
      {lines ? (
        <style>{`[data-code="${id}"] pre code > span:is(${lines}) { background: color-mix(in oklab, var(--color-kumo-brand) 12%, transparent); box-shadow: inset 2px 0 var(--color-kumo-brand); }`}</style>
      ) : null}
      <Markdown text={`\`\`\`${language}\n${code}\n\`\`\``} streaming={false} />
    </div>
  );
}

/**
 * The agent's code in three steps, each a whole file that builds on the
 * last, then what the model writes with it, as a fourth.
 */
function CodeSteps() {
  const [index, setIndex] = useState(0);
  const step = CODE_STEPS[index] ?? CODE_STEPS[0];
  return (
    <section className="flex flex-col gap-4">
      <SectionTitle>The code</SectionTitle>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <Tabs
            variant="segmented"
            size="sm"
            value={String(index)}
            onValueChange={(value) => setIndex(Number(value))}
            tabs={CODE_STEPS.map((codeStep, i) => ({
              value: String(i),
              label: `${i + 1}. ${codeStep.label}`
            }))}
          />
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              shape="square"
              aria-label="Previous step"
              icon={<CaretLeftIcon size={14} />}
              disabled={index === 0}
              onClick={() => setIndex(index - 1)}
            />
            <Button
              size="sm"
              variant="ghost"
              shape="square"
              aria-label="Next step"
              icon={<CaretRightIcon size={14} />}
              disabled={index === CODE_STEPS.length - 1}
              onClick={() => setIndex(index + 1)}
            />
          </div>
        </div>
        <h4 className="text-sm font-medium text-kumo-default">{step.title}</h4>
        <p className="text-sm text-kumo-subtle">
          {step.caption}
          {step.added.length > 0 ? " New lines are highlighted." : ""}
        </p>
        <CodeBlock
          language={step.language}
          code={step.code}
          added={step.added}
        />
      </div>
    </section>
  );
}

export function AboutDialog({
  open,
  onOpenChange,
  tools,
  activeTools
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tools: readonly ToolInfo[];
  activeTools: readonly string[];
}) {
  const browser = tools.find((tool) => tool.name === "browser");
  const others = tools.filter((tool) => tool.name !== "browser");
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog className="flex h-[calc(100dvh-2rem)] flex-col sm:w-[44rem] lg:w-[min(76rem,calc(100vw-4rem))]">
        <div className="flex items-start justify-between gap-4 border-b border-kumo-line px-5 py-4">
          <div className="flex flex-col gap-1">
            <Dialog.Title className="text-base font-semibold text-kumo-default">
              How it works
            </Dialog.Title>
            <Dialog.Description className="text-sm text-kumo-subtle">
              An agent builds a site in its container and checks it in its own
              browser, on hostnames only that browser can open.
            </Dialog.Description>
          </div>
          <Dialog.Close
            render={
              <Button
                size="sm"
                variant="ghost"
                shape="square"
                aria-label="Close"
                icon={<XIcon size={14} />}
              />
            }
          />
        </div>

        <div className="flex min-h-0 flex-col gap-6 overflow-y-auto px-5 py-4">
          <Diagram />

          <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[20rem_minmax(0,1fr)] lg:items-start">
            <section className="flex flex-col gap-3 lg:sticky lg:top-0">
              <SectionTitle>Tools</SectionTitle>
              {browser ? (
                <div className="flex flex-col gap-2 rounded-xl px-3 py-2.5 ring-1 ring-kumo-line">
                  <div className="flex items-center gap-2">
                    <CompassIcon size={14} className="text-kumo-brand" />
                    <ToolName
                      name={browser.name}
                      active={activeTools.includes(browser.name)}
                    />
                    <span className="text-sm text-kumo-subtle">
                      Drive the browser with CDP code
                    </span>
                  </div>
                  <ul className="flex flex-col gap-1 text-sm text-kumo-default">
                    <li>
                      Opens pages and takes screenshots you see in the chat
                    </li>
                    <li>
                      Points <HostChip host={PREVIEW_HOST} /> at a port and{" "}
                      <HostChip host={FILES_HOST} /> at a folder
                    </li>
                    <li>
                      Reads its instructions on <HostChip host={DOCS_HOST} />
                    </li>
                  </ul>
                </div>
              ) : null}
              {others.length > 0 ? (
                <div className="flex flex-col gap-2 rounded-xl px-3 py-2.5 ring-1 ring-kumo-line">
                  <div className="flex items-center gap-2">
                    <TerminalWindowIcon size={14} className="text-kumo-brand" />
                    <span className="text-sm font-medium text-kumo-default">
                      Workspace
                    </span>
                    <span className="text-sm text-kumo-subtle">
                      Files in <code>/workspace</code>, synced to the container
                    </span>
                  </div>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                    {others.map((tool) => (
                      <div key={tool.name} className="contents">
                        <dt>
                          <ToolName
                            name={tool.name}
                            active={activeTools.includes(tool.name)}
                          />
                        </dt>
                        <dd className="text-kumo-subtle">
                          {TOOL_SUMMARIES[tool.name] ??
                            firstSentence(tool.description)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ) : null}
              {tools.length === 0 ? (
                <p className="text-sm text-kumo-subtle">Connecting…</p>
              ) : null}
            </section>

            <CodeSteps />
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
