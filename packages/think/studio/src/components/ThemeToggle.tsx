import { useState } from "react";
import { Button } from "@cloudflare/kumo";
import { MoonIcon, SunIcon } from "@phosphor-icons/react";

type Mode = "light" | "dark";

function currentMode(): Mode {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-mode") === "dark"
    ? "dark"
    : "light";
}

/**
 * Toggles the `data-mode` attribute the Kumo theme keys off, persisting the
 * choice to `localStorage` (the inline script in index.html applies it on the
 * next load to avoid a flash).
 */
export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>(currentMode);

  const toggle = () => {
    const next: Mode = mode === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-mode", next);
    document.documentElement.style.colorScheme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {
      // Private mode / storage disabled — the in-memory toggle still works.
    }
    setMode(next);
  };

  return (
    <Button
      variant="ghost"
      shape="square"
      size="sm"
      aria-label={
        mode === "dark" ? "Switch to light theme" : "Switch to dark theme"
      }
      onClick={toggle}
      icon={mode === "dark" ? <SunIcon size={16} /> : <MoonIcon size={16} />}
    />
  );
}
