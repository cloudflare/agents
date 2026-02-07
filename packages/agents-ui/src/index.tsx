import { forwardRef } from "react";
import { Button } from "@cloudflare/kumo";
import { SunIcon, MoonIcon, MonitorIcon } from "@phosphor-icons/react";
import { useTheme } from "./hooks";

/* ── ConnectionStatus ──
   Displays a colored dot and label for WebSocket connection state. */

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

interface ConnectionStatusProps {
  status: ConnectionStatus;
}

const statusConfig: Record<
  ConnectionStatus,
  { label: string; dotClass: string; textClass: string }
> = {
  connecting: {
    label: "Connecting...",
    dotClass: "bg-yellow-500",
    textClass: "text-kumo-warning"
  },
  connected: {
    label: "Connected",
    dotClass: "bg-green-500",
    textClass: "text-kumo-success"
  },
  disconnected: {
    label: "Disconnected",
    dotClass: "bg-red-500",
    textClass: "text-kumo-danger"
  }
};

export function ConnectionIndicator({ status }: ConnectionStatusProps) {
  const { label, dotClass, textClass } = statusConfig[status];
  return (
    <div className="flex items-center gap-2" role="status" aria-live="polite">
      <span className={`size-2 rounded-full ${dotClass}`} aria-hidden="true" />
      <span className={textClass}>{label}</span>
    </div>
  );
}

/* ── ModeToggle ──
   Cycles through system → light → dark theme modes.
   Requires <ThemeProvider> from "@cloudflare/agents-ui/hooks". */

export function ModeToggle() {
  const { mode, setMode } = useTheme();

  const cycle = () => {
    const modes = ["system", "light", "dark"] as const;
    const idx = modes.indexOf(mode);
    setMode(modes[(idx + 1) % modes.length]);
  };

  const icon =
    mode === "light" ? (
      <SunIcon size={16} />
    ) : mode === "dark" ? (
      <MoonIcon size={16} />
    ) : (
      <MonitorIcon size={16} />
    );

  const label =
    mode === "light" ? "Light" : mode === "dark" ? "Dark" : "System";

  return (
    <Button
      variant="secondary"
      icon={icon}
      onClick={cycle}
      title={`Theme: ${label}`}
    >
      {label}
    </Button>
  );
}

/* ── CloudflareLogo ──
   Cloudflare cloud glyph in brand colors. */

const CLOUDFLARE_ORANGE = "#F48120";
const CLOUDFLARE_YELLOW = "#FAAD3F";

export const CloudflareLogo = forwardRef<
  SVGSVGElement,
  React.SVGAttributes<SVGSVGElement>
>(({ className, ...props }, ref) => (
  <svg
    ref={ref}
    viewBox="0 0 49 22"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    role="img"
    aria-label="Cloudflare"
    className={className}
    {...props}
  >
    <path
      d="M33.204 20.4C33.3649 19.9741 33.4217 19.5159 33.3695 19.0636C33.3173 18.6113 33.1577 18.1781 32.904 17.8C32.6435 17.4876 32.3239 17.2297 31.9636 17.0409C31.6032 16.8522 31.2092 16.7363 30.804 16.7L13.404 16.5C13.304 16.5 13.204 16.4 13.104 16.4C13.0808 16.3825 13.0618 16.3599 13.0488 16.3339C13.0358 16.3078 13.029 16.2791 13.029 16.25C13.029 16.2209 13.0358 16.1922 13.0488 16.1662C13.0618 16.1401 13.0808 16.1175 13.104 16.1C13.204 15.9 13.304 15.8 13.504 15.8L31.004 15.6C32.115 15.4767 33.1731 15.0597 34.0695 14.3918C34.9659 13.7239 35.6681 12.8293 36.104 11.8L37.104 9.20002C37.104 9.10002 37.204 9.00001 37.104 8.90001C36.5604 6.47843 35.2411 4.30052 33.3466 2.69721C31.4521 1.09391 29.086 0.152865 26.6079 0.0170769C24.1298 -0.118712 21.675 0.558179 19.6167 1.94489C17.5584 3.33161 16.009 5.35233 15.204 7.70002C14.159 6.95365 12.8843 6.59957 11.604 6.70002C10.4291 6.83102 9.33369 7.35777 8.49774 8.19372C7.66179 9.02966 7.13505 10.1251 7.00404 11.3C6.93745 11.9014 6.97125 12.5097 7.10404 13.1C5.20298 13.1526 3.39743 13.9448 2.07147 15.3081C0.745511 16.6714 0.00377461 18.4982 0.00403983 20.4C-0.0123708 20.7695 0.0212659 21.1395 0.104038 21.5C0.10863 21.5781 0.141713 21.6517 0.19701 21.707C0.252307 21.7623 0.325975 21.7954 0.404041 21.8H32.504C32.704 21.8 32.904 21.7 32.904 21.5L33.204 20.4Z"
      fill={CLOUDFLARE_ORANGE}
    />
    <path
      d="M38.704 9.20002H38.204C38.104 9.20002 38.004 9.30001 37.904 9.40001L37.204 11.8C37.0431 12.2259 36.9864 12.6841 37.0386 13.1364C37.0908 13.5887 37.2504 14.0219 37.504 14.4C37.7646 14.7124 38.0842 14.9704 38.4445 15.1591C38.8049 15.3479 39.1989 15.4637 39.604 15.5L43.304 15.7C43.404 15.7 43.504 15.8 43.604 15.8C43.6273 15.8175 43.6462 15.8401 43.6592 15.8662C43.6723 15.8922 43.679 15.9209 43.679 15.95C43.679 15.9791 43.6723 16.0078 43.6592 16.0339C43.6462 16.0599 43.6273 16.0826 43.604 16.1C43.504 16.3 43.404 16.4 43.204 16.4L39.404 16.6C38.293 16.7233 37.2349 17.1403 36.3386 17.8082C35.4422 18.4761 34.74 19.3707 34.304 20.4L34.104 21.3C34.004 21.4 34.104 21.6 34.304 21.6H47.504C47.5448 21.6058 47.5863 21.6021 47.6254 21.5891C47.6644 21.5761 47.6999 21.5541 47.729 21.525C47.7581 21.4959 47.7801 21.4604 47.7931 21.4214C47.8061 21.3823 47.8099 21.3408 47.804 21.3C48.0421 20.4527 48.1764 19.5797 48.204 18.7C48.1882 16.1854 47.1822 13.7782 45.404 12C43.6259 10.2218 41.2187 9.21587 38.704 9.20002Z"
      fill={CLOUDFLARE_YELLOW}
    />
  </svg>
));
CloudflareLogo.displayName = "CloudflareLogo";

/* ── PoweredByAgents ──
   "Powered by Cloudflare Agents" footer badge.
   Links to the Agents SDK docs. */

export interface PoweredByAgentsProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  /** Override the link destination */
  href?: string;
}

export const PoweredByAgents = forwardRef<
  HTMLAnchorElement,
  PoweredByAgentsProps
>(
  (
    { href = "https://developers.cloudflare.com/agents/", className, ...props },
    ref
  ) => (
    <a
      ref={ref}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-3 text-xs text-kumo-inactive transition-colors hover:text-kumo-subtle ${className ?? ""}`}
      {...props}
    >
      <CloudflareLogo className="h-5 w-auto shrink-0" />
      <span className="flex flex-col whitespace-nowrap leading-snug">
        <span>Powered by</span>
        <span className="font-semibold text-kumo-default">
          Cloudflare Agents
        </span>
      </span>
    </a>
  )
);
PoweredByAgents.displayName = "PoweredByAgents";
