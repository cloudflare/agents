import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";

export function Layout() {
  return (
    <div className="h-full flex bg-white dark:bg-neutral-900">
      <Sidebar />
      <main className="flex-1 overflow-y-auto bg-white dark:bg-neutral-900">
        <Outlet />
      </main>
    </div>
  );
}
