import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode
} from "react";

type Mode = "light" | "dark" | "system";
type ColorTheme = "workers" | "kumo";

const COLOR_THEMES: ColorTheme[] = ["workers", "kumo"];

interface ThemeContextValue {
  mode: Mode;
  resolvedMode: "light" | "dark";
  setMode: (mode: Mode) => void;
  colorTheme: ColorTheme;
  setColorTheme: (theme: ColorTheme) => void;
  colorThemes: readonly ColorTheme[];
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function getStoredMode(): Mode {
  if (typeof window === "undefined") return "system";
  const stored = localStorage.getItem("theme");
  if (stored === "light" || stored === "dark" || stored === "system") {
    return stored;
  }
  return "system";
}

function getStoredColorTheme(): ColorTheme {
  if (typeof window === "undefined") return "workers";
  const stored = localStorage.getItem("color-theme");
  if (stored === "workers" || stored === "kumo") {
    return stored;
  }
  return "workers";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<Mode>(getStoredMode);
  const [resolvedMode, setResolvedMode] = useState<"light" | "dark">(() =>
    mode === "system" ? getSystemTheme() : mode
  );
  const [colorTheme, setColorThemeState] =
    useState<ColorTheme>(getStoredColorTheme);

  const setMode = (newMode: Mode) => {
    setModeState(newMode);
    localStorage.setItem("theme", newMode);
  };

  const setColorTheme = (newTheme: ColorTheme) => {
    setColorThemeState(newTheme);
    localStorage.setItem("color-theme", newTheme);
  };

  // Update data-mode when mode changes or system preference changes
  useEffect(() => {
    const updateResolved = () => {
      const resolved = mode === "system" ? getSystemTheme() : mode;
      setResolvedMode(resolved);

      // Set data-mode attribute for Kumo semantic tokens
      document.documentElement.setAttribute("data-mode", resolved);
      // Set color-scheme for native form elements
      document.documentElement.style.colorScheme = resolved;
    };

    updateResolved();

    // Listen for system preference changes
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (mode === "system") {
        updateResolved();
      }
    };

    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, [mode]);

  // Update data-theme when colorTheme changes
  useEffect(() => {
    if (colorTheme === "kumo") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", colorTheme);
    }
  }, [colorTheme]);

  return (
    <ThemeContext.Provider
      value={{
        mode,
        resolvedMode,
        setMode,
        colorTheme,
        setColorTheme,
        colorThemes: COLOR_THEMES
      }}
    >
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
