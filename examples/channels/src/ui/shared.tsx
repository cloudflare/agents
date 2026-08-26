import { useEffect, useState, type ReactNode } from "react";
import {
  Badge,
  Banner,
  Button,
  Tooltip,
  type BadgeVariant
} from "@cloudflare/kumo";
import {
  ChatCircleDotsIcon,
  ClipboardTextIcon,
  EnvelopeSimpleIcon,
  MoonIcon,
  PaperPlaneTiltIcon,
  PlugsConnectedIcon,
  SunIcon,
  WarningCircleIcon
} from "@phosphor-icons/react";
import type { ChannelIdentity, UserIdentity } from "@cloudflare/channels";

type Presentation = { label: string; icon: ReactNode; badge: BadgeVariant };

const PROVIDERS: Record<string, Presentation> = {
  slack: {
    label: "Slack",
    icon: <ChatCircleDotsIcon size={15} weight="fill" />,
    badge: "purple"
  },
  telegram: {
    label: "Telegram",
    icon: <PaperPlaneTiltIcon size={15} weight="fill" />,
    badge: "blue"
  },
  email: {
    label: "Email",
    icon: <EnvelopeSimpleIcon size={15} weight="fill" />,
    badge: "teal"
  },
  "support-form": {
    label: "Support form",
    icon: <ClipboardTextIcon size={15} weight="fill" />,
    badge: "orange"
  }
};

export function provider(name: string): Presentation {
  return (
    PROVIDERS[name] ?? {
      label: name,
      icon: <PlugsConnectedIcon size={15} weight="fill" />,
      badge: "neutral"
    }
  );
}

export function ProviderAvatar({
  channelKey,
  size = "base"
}: {
  channelKey: string;
  size?: "sm" | "base";
}) {
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-subtle ${
        size === "sm" ? "size-7" : "size-9"
      }`}
    >
      {provider(channelKey).icon}
    </span>
  );
}

export function ProviderBadge({ channelKey }: { channelKey: string }) {
  const { badge, label } = provider(channelKey);
  return <Badge variant={badge}>{label}</Badge>;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatClock(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function formatFullTime(timestamp: string): string {
  return new Date(timestamp).toLocaleString();
}

export function userLabel(user: UserIdentity): string {
  return `User ${user.id.slice(0, 8)}`;
}

export function identityLabel(identity: ChannelIdentity): string {
  return `${provider(identity.channelKey).label} · ${identity.subject}`;
}

export function Timestamp({ at }: { at: string }) {
  return (
    <Tooltip
      content={formatFullTime(at)}
      render={
        <span className="cursor-help text-xs text-kumo-inactive">
          {formatClock(at)}
        </span>
      }
    />
  );
}

export function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") || "light"
  );
  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);

  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label={mode === "light" ? "Use dark theme" : "Use light theme"}
      onClick={() => setMode(mode === "light" ? "dark" : "light")}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="shrink-0 px-5 pt-3">
      <Banner
        variant="error"
        role="alert"
        icon={<WarningCircleIcon size={18} weight="bold" />}
        title="Action failed"
        description={message}
      />
    </div>
  );
}
