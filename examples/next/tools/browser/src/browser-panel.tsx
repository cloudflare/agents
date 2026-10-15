import { Badge, Button, Surface, Text } from "@cloudflare/kumo";
import {
  AppWindowIcon,
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  PowerIcon,
  XIcon
} from "@phosphor-icons/react";
import type { BrowserLiveViewTarget, InternalHostInfo } from "agents/browser";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { BrowserState } from "./shared";

/**
 * The agent's browser for the UI: Live View URLs and each internal host's
 * target, from `GET /api/browser/<session>`. Polls while a turn runs, since
 * that's when the agent opens pages and assigns hosts.
 */
export function useBrowserState(session: string, running: boolean) {
  const [state, setState] = useState<BrowserState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/browser/${session}`);
      if (!response.ok) throw new Error(await response.text());
      setState((await response.json()) as BrowserState);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [session]);

  const close = useCallback(async () => {
    setBusy(true);
    try {
      await fetch(`/api/browser/${session}`, { method: "DELETE" });
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [session, refresh]);

  // Once on load and when a turn ends, then every 5s during a turn.
  useEffect(() => {
    setState(null);
    void refresh();
    if (!running) return;
    const id = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(id);
  }, [refresh, running]);

  return { state, busy, error, refresh, close };
}

/** Real pages only: skip the initial about:blank tab and chrome:// pages. */
function pageTargets(state: BrowserState | null): BrowserLiveViewTarget[] {
  return (state?.liveView?.targets ?? []).filter((target) => {
    const page = target.pageUrl ?? "";
    return (
      (target.type ?? "page") === "page" &&
      page !== "about:blank" &&
      !page.startsWith("chrome://") &&
      !page.startsWith("devtools://")
    );
  });
}

function tabLabel(target: BrowserLiveViewTarget): string {
  const title = target.title?.trim();
  if (title) return title;
  try {
    return new URL(target.pageUrl ?? "").host || "New tab";
  } catch {
    return target.pageUrl ?? "New tab";
  }
}

/** A host's current target, in a few words. */
function targetLabel(host: InternalHostInfo): string {
  if (!host.assignable) return "Docs Worker";
  if (host.target === undefined) return "Unassigned";
  if (typeof host.target !== "object" || host.target === null) {
    return String(host.target);
  }
  const target = host.target as Record<string, unknown>;
  if (typeof target.port === "number") return `Port ${target.port}`;
  return Object.values(target).map(String).join(", ");
}

function HostList({ hosts }: { hosts: readonly InternalHostInfo[] }) {
  return (
    <ul className="space-y-1.5" aria-label="Internal hostnames">
      {hosts.map((host) => (
        <li key={host.host}>
          <Surface className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 ring ring-kumo-line">
            <div className="min-w-0">
              <code className="text-xs font-semibold">{host.host}</code>
              <p className="truncate text-[11px] text-kumo-subtle">
                {host.description}
              </p>
            </div>
            <Badge
              variant={
                host.assignable && host.target === undefined
                  ? "secondary"
                  : "success"
              }
            >
              <span className="max-w-40 truncate font-mono">
                {targetLabel(host)}
              </span>
            </Badge>
          </Surface>
        </li>
      ))}
    </ul>
  );
}

export function BrowserPanel({
  state,
  busy,
  error,
  onRefresh,
  onCloseBrowser,
  onClose
}: {
  state: BrowserState | null;
  busy: boolean;
  error: string | null;
  onRefresh: () => void;
  onCloseBrowser: () => void;
  onClose: () => void;
}) {
  const targets = useMemo(() => pageTargets(state), [state]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    targets.find((target) => target.targetId === selectedId) ??
    targets.at(-1) ??
    null;
  // Live View URLs are re-minted on every poll. Keep the iframe on the URL
  // it loaded with, so a poll doesn't reload it.
  const [embedded, setEmbedded] = useState<{ id: string; url: string } | null>(
    null
  );
  useEffect(() => {
    if (!selected) setEmbedded(null);
    else if (embedded?.id !== selected.targetId) {
      setEmbedded({ id: selected.targetId, url: selected.url });
    }
  }, [selected, embedded]);

  return (
    <aside
      className="flex min-h-0 flex-col border-l border-kumo-line bg-kumo-base"
      aria-label="Browser"
    >
      <div className="flex h-[68px] shrink-0 items-center justify-between gap-2 border-b border-kumo-line px-4">
        <Text size="sm" bold>
          Browser
        </Text>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            shape="square"
            aria-label="Refresh"
            disabled={busy}
            icon={<ArrowClockwiseIcon size={14} />}
            onClick={onRefresh}
          />
          <Button
            size="sm"
            variant="ghost"
            icon={<PowerIcon size={14} />}
            disabled={busy || !state?.liveView}
            onClick={onCloseBrowser}
          >
            Close browser
          </Button>
          <Button
            size="sm"
            variant="ghost"
            shape="square"
            aria-label="Close panel"
            icon={<XIcon size={14} />}
            onClick={onClose}
          />
        </div>
      </div>

      <div className="shrink-0 border-b border-kumo-line p-3">
        <HostList hosts={state?.hosts ?? []} />
      </div>

      {error ? (
        <p className="border-b border-kumo-line px-4 py-2 text-xs text-kumo-danger">
          {error}
        </p>
      ) : null}

      {selected === null ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
          <AppWindowIcon size={28} className="text-kumo-inactive" />
          <p className="text-sm font-medium">No page open yet</p>
          <p className="max-w-xs text-xs text-kumo-subtle">
            When the agent opens a page, its tab shows up here live.
          </p>
        </div>
      ) : (
        <>
          {targets.length > 1 ? (
            <div
              role="tablist"
              aria-label="Browser tabs"
              className="flex shrink-0 gap-1 overflow-x-auto border-b border-kumo-line px-2 py-1.5"
            >
              {targets.map((target) => (
                <button
                  key={target.targetId}
                  type="button"
                  role="tab"
                  aria-selected={target.targetId === selected.targetId}
                  title={target.pageUrl}
                  onClick={() => setSelectedId(target.targetId)}
                  className={`max-w-48 shrink-0 truncate rounded-md px-2.5 py-1 text-xs transition-colors ${
                    target.targetId === selected.targetId
                      ? "bg-kumo-tint text-kumo-default"
                      : "text-kumo-subtle hover:bg-kumo-tint"
                  }`}
                >
                  {tabLabel(target)}
                </button>
              ))}
            </div>
          ) : null}
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-kumo-line px-4 py-1.5">
            <span className="truncate font-mono text-xs text-kumo-subtle">
              {selected.pageUrl}
            </span>
            <a
              href={selected.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-1 text-xs text-kumo-subtle hover:text-kumo-default"
            >
              <ArrowSquareOutIcon size={12} />
              Open
            </a>
          </div>
          {/* Live View has its own controls: you can click around the page
              in it too. */}
          <div className="min-h-0 flex-1 bg-white">
            {embedded ? (
              <iframe
                key={embedded.url}
                title="Live View of the agent's browser"
                src={embedded.url}
                className="h-full w-full"
                allow="clipboard-read; clipboard-write"
              />
            ) : null}
          </div>
        </>
      )}
    </aside>
  );
}
