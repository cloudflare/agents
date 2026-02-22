import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode
} from "react";

type Mode = "light" | "dark" | "system";

interface ThemeContextValue {
  mode: Mode;
  resolvedMode: "light" | "dark";
  setMode: (mode: Mode) => void;
}

const STORAGE_KEY = "theme";

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function getStoredMode(): Mode {
  if (typeof window === "undefined") return "system";
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") {
    return stored;
  }
  return "system";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<Mode>(getStoredMode);
  const [resolvedMode, setResolvedMode] = useState<"light" | "dark">(() =>
    mode === "system" ? getSystemTheme() : mode
  );

  const setMode = (newMode: Mode) => {
    setModeState(newMode);
    localStorage.setItem(STORAGE_KEY, newMode);
  };

  useEffect(() => {
    const updateResolved = () => {
      const resolved = mode === "system" ? getSystemTheme() : mode;
      setResolvedMode(resolved);
      document.documentElement.setAttribute("data-mode", resolved);
      document.documentElement.style.colorScheme = resolved;
    };

    updateResolved();

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (mode === "system") {
        updateResolved();
      }
    };

    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, [mode]);

  return (
    <ThemeContext.Provider value={{ mode, resolvedMode, setMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
