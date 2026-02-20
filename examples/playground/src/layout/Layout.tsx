import { useState, useCallback } from "react";
import { Outlet } from "react-router-dom";
import { Button } from "@cloudflare/kumo";
import { ListIcon } from "@phosphor-icons/react";
import { PoweredByAgents } from "@cloudflare/agents-ui";
import { Sidebar } from "./Sidebar";

export function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  return (
    <div className="h-full flex flex-col md:flex-row bg-kumo-base">
      {/* Mobile header */}
      <header className="md:hidden flex items-center justify-between px-4 py-3 border-b border-kumo-line bg-kumo-base shrink-0">
        <Button
          variant="ghost"
          shape="square"
          size="sm"
          icon={<ListIcon size={20} />}
          onClick={() => setSidebarOpen(true)}
          aria-label="Open navigation"
        />
        <PoweredByAgents />
        <div className="w-8" />
      </header>

      <Sidebar open={sidebarOpen} onClose={closeSidebar} />

      <main className="flex-1 overflow-y-auto bg-kumo-base min-h-0">
        <Outlet />
      </main>
    </div>
  );
}
