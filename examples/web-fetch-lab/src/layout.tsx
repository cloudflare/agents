import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@cloudflare/kumo";
import { SidebarSimpleIcon, XIcon } from "@phosphor-icons/react";
import { useMediaQuery } from "./chat-ui";

/** A titled block in a sidebar. */
export function SidebarSection({
  title,
  action,
  children
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium tracking-wide text-kumo-subtle uppercase">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * Main content with a sidebar on the right: a fixed panel on wide screens,
 * a drawer over the content on narrow ones. `sidebar` gets an `onClose`
 * when it is a drawer, so its first section can show a close button.
 * `toolbar` is rendered on the top row, left of the sidebar toggle.
 */
export function WithSidebar({
  label,
  sidebar,
  toolbar,
  children
}: {
  label: string;
  sidebar: (props: { onClose?: () => void }) => ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  const isWide = useMediaQuery("(min-width: 1024px)");
  const [panelOpen, setPanelOpen] = useState(isWide);
  useEffect(() => setPanelOpen(isWide), [isWide]);

  const panel = sidebar({
    onClose: isWide ? undefined : () => setPanelOpen(false)
  });

  return (
    <div className="flex h-full min-h-0">
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-end gap-1 px-4 pt-2">
          {toolbar}
          <Button
            size="sm"
            variant="ghost"
            shape="square"
            aria-label={panelOpen ? `Hide ${label}` : `Show ${label}`}
            aria-expanded={panelOpen}
            icon={<SidebarSimpleIcon size={14} className="-scale-x-100" />}
            onClick={() => setPanelOpen((open) => !open)}
          />
        </div>
        {children}
      </main>

      {isWide && panelOpen && (
        <aside
          aria-label={label}
          className="w-80 shrink-0 border-l border-kumo-line"
        >
          {panel}
        </aside>
      )}
      {!isWide && panelOpen && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <button
            type="button"
            aria-label="Close panel"
            className="absolute inset-0 bg-black/30"
            onClick={() => setPanelOpen(false)}
          />
          <aside
            aria-label={label}
            className="relative w-[min(22rem,90vw)] shadow-xl"
          >
            {panel}
          </aside>
        </div>
      )}
    </div>
  );
}

/** The scrolling column a sidebar is made of. */
export function SidebarBody({
  children,
  containerRef
}: {
  children: ReactNode;
  containerRef?: (element: HTMLElement | null) => void;
}) {
  return (
    <div
      ref={containerRef}
      className="flex h-full flex-col gap-8 overflow-y-auto bg-kumo-elevated p-5"
    >
      {children}
    </div>
  );
}

/** The close button for a drawer's first section. */
export function CloseSidebarButton({ onClose }: { onClose?: () => void }) {
  if (!onClose) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      shape="square"
      aria-label="Close panel"
      icon={<XIcon size={14} />}
      onClick={onClose}
    />
  );
}
