import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";

export function Layout() {
  return (
    <div className="h-full flex bg-kumo-base">
      <Sidebar />
      <main className="flex-1 overflow-y-auto bg-kumo-base">
        <Outlet />
      </main>
    </div>
  );
}
