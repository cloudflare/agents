// The "How it works" dialog: what the demo is, as a diagram, and the
// agent's tools in one line each.
import { Button, Dialog } from "@cloudflare/kumo";
import {
  ArrowDownIcon,
  ArrowRightIcon,
  BrainIcon,
  CircleNotchIcon,
  CompassIcon,
  TerminalWindowIcon,
  XIcon
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { ToolInfo } from "./protocol";
import { DOCS_HOST, FILES_HOST, PREVIEW_HOST } from "./shared";

/** Each internal hostname and what it reaches. */
export const HOSTS = [
  { host: PREVIEW_HOST, serves: "Dev server in the container" },
  { host: FILES_HOST, serves: "A workspace folder, e.g. dist" },
  { host: DOCS_HOST, serves: "Docs Worker with build steps" }
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

/** Agent → Browser → three internal hosts → what each one reaches. */
function Diagram() {
  return (
    <figure
      aria-label="The agent drives a browser on Browser Run, which opens three internal hostnames"
      className="flex flex-col items-stretch gap-2 rounded-xl bg-kumo-elevated p-3 sm:flex-row sm:items-center"
    >
      <Box
        icon={<BrainIcon size={16} weight="duotone" />}
        title="Agent"
        caption="pi + workspace"
      />
      <Arrow />
      <Box
        icon={<CompassIcon size={16} weight="duotone" />}
        title="Browser"
        caption="Browser Run"
      />
      <Arrow />
      <ul className="flex flex-col gap-1.5">
        {HOSTS.map(({ host, serves }) => (
          <li key={host} className="flex flex-col gap-0.5">
            <HostChip host={host} />
            <span className="pl-1.5 text-xs text-kumo-subtle">{serves}</span>
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
      <Dialog className="flex max-h-[calc(100dvh-2rem)] flex-col sm:w-[36rem]">
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

          <section className="flex flex-col gap-3">
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
                  <li>Opens pages and takes screenshots you see in the chat</li>
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
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
