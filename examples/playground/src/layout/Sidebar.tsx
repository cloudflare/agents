import {
  CaretDownIcon,
  CaretRightIcon,
  CubeIcon,
  ChatDotsIcon,
  HardDrivesIcon,
  GitBranchIcon,
  EnvelopeIcon,
  DatabaseIcon,
  LightningIcon,
  ClockIcon,
  UsersIcon,
  CpuIcon,
  WrenchIcon,
  KeyIcon,
  PlayCircleIcon,
  CheckCircleIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
  SignpostIcon,
  TreeStructureIcon,
  ChatCircleIcon,
  StackIcon,
  GitMergeIcon,
  ShieldIcon,
  PaletteIcon
} from "@phosphor-icons/react";
import { useState } from "react";
import { NavLink } from "react-router-dom";
import { Button, Link } from "@cloudflare/kumo";
import { useTheme } from "../hooks/useTheme";

interface NavItem {
  label: string;
  path: string;
  icon: React.ReactNode;
}

interface NavCategory {
  label: string;
  icon: React.ReactNode;
  items: NavItem[];
}

const navigation: NavCategory[] = [
  {
    label: "Core",
    icon: <CubeIcon size={16} />,
    items: [
      {
        label: "State",
        path: "/core/state",
        icon: <DatabaseIcon size={16} />
      },
      {
        label: "Callable",
        path: "/core/callable",
        icon: <LightningIcon size={16} />
      },
      {
        label: "Streaming",
        path: "/core/streaming",
        icon: <PlayCircleIcon size={16} />
      },
      {
        label: "Schedule",
        path: "/core/schedule",
        icon: <ClockIcon size={16} />
      },
      {
        label: "Connections",
        path: "/core/connections",
        icon: <UsersIcon size={16} />
      },
      {
        label: "SQL",
        path: "/core/sql",
        icon: <DatabaseIcon size={16} />
      },
      {
        label: "Routing",
        path: "/core/routing",
        icon: <SignpostIcon size={16} />
      }
    ]
  },
  {
    label: "AI",
    icon: <CpuIcon size={16} />,
    items: [
      {
        label: "Chat",
        path: "/ai/chat",
        icon: <ChatDotsIcon size={16} />
      },
      {
        label: "Tools",
        path: "/ai/tools",
        icon: <WrenchIcon size={16} />
      }
    ]
  },
  {
    label: "MCP",
    icon: <HardDrivesIcon size={16} />,
    items: [
      {
        label: "Server",
        path: "/mcp/server",
        icon: <HardDrivesIcon size={16} />
      },
      {
        label: "Client",
        path: "/mcp/client",
        icon: <CpuIcon size={16} />
      },
      {
        label: "OAuth",
        path: "/mcp/oauth",
        icon: <KeyIcon size={16} />
      }
    ]
  },
  {
    label: "Workflows",
    icon: <GitBranchIcon size={16} />,
    items: [
      {
        label: "Basic",
        path: "/workflow/basic",
        icon: <PlayCircleIcon size={16} />
      },
      {
        label: "Approval",
        path: "/workflow/approval",
        icon: <CheckCircleIcon size={16} />
      }
    ]
  },
  {
    label: "Multi-Agent",
    icon: <TreeStructureIcon size={16} />,
    items: [
      {
        label: "Supervisor",
        path: "/multi-agent/supervisor",
        icon: <UsersIcon size={16} />
      },
      {
        label: "Chat Rooms",
        path: "/multi-agent/rooms",
        icon: <ChatCircleIcon size={16} />
      },
      {
        label: "Workers",
        path: "/multi-agent/workers",
        icon: <StackIcon size={16} />
      },
      {
        label: "Pipeline",
        path: "/multi-agent/pipeline",
        icon: <GitMergeIcon size={16} />
      }
    ]
  },
  {
    label: "Email",
    icon: <EnvelopeIcon size={16} />,
    items: [
      {
        label: "Receive",
        path: "/email/receive",
        icon: <EnvelopeIcon size={16} />
      },
      {
        label: "Secure Replies",
        path: "/email/secure",
        icon: <ShieldIcon size={16} />
      }
    ]
  }
];

function CategorySection({ category }: { category: NavCategory }) {
  const [isOpen, setIsOpen] = useState(true);

  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-controls={`nav-category-${category.label.toLowerCase().replace(/\s+/g, "-")}`}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-kumo-subtle hover:text-kumo-default bg-kumo-control rounded-md transition-colors"
      >
        {isOpen ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
        {category.icon}
        {category.label}
      </button>

      {isOpen && (
        <div
          id={`nav-category-${category.label.toLowerCase().replace(/\s+/g, "-")}`}
          role="region"
          aria-label={`${category.label} navigation`}
          className="ml-5 mt-1 space-y-0.5"
        >
          {category.items.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                `flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors ${
                  isActive
                    ? "bg-kumo-control text-kumo-default font-medium"
                    : "text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
                }`
              }
            >
              {item.icon}
              {item.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

function ModeToggle() {
  const { mode, setMode } = useTheme();

  const cycleMode = () => {
    if (mode === "system") setMode("light");
    else if (mode === "light") setMode("dark");
    else setMode("system");
  };

  const icon =
    mode === "system" ? (
      <MonitorIcon size={16} />
    ) : mode === "light" ? (
      <SunIcon size={16} />
    ) : (
      <MoonIcon size={16} />
    );

  return (
    <Button
      variant="ghost"
      size="sm"
      icon={icon}
      onClick={cycleMode}
      title={`Mode: ${mode}`}
    >
      <span className="text-xs capitalize">{mode}</span>
    </Button>
  );
}

function ColorThemeToggle() {
  const { colorTheme, setColorTheme, colorThemes } = useTheme();

  const cycleColorTheme = () => {
    const idx = colorThemes.indexOf(colorTheme);
    const next = colorThemes[(idx + 1) % colorThemes.length];
    setColorTheme(next);
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      icon={<PaletteIcon size={16} />}
      onClick={cycleColorTheme}
      title={`Color theme: ${colorTheme}`}
    >
      <span className="text-xs capitalize">{colorTheme}</span>
    </Button>
  );
}

export function Sidebar() {
  return (
    <aside className="w-56 h-full border-r border-kumo-line bg-kumo-base flex flex-col">
      <div className="p-4 border-b border-kumo-line">
        <h1 className="font-bold text-lg text-kumo-default">Agents SDK</h1>
        <p className="text-xs text-kumo-subtle">Playground</p>
      </div>

      <nav className="flex-1 overflow-y-auto p-2">
        {navigation.map((category) => (
          <CategorySection key={category.label} category={category} />
        ))}
      </nav>

      <div className="p-4 border-t border-kumo-line space-y-2">
        <ModeToggle />
        <ColorThemeToggle />
        <div className="text-xs text-kumo-subtle">
          <Link href="https://github.com/cloudflare/agents" variant="inline">
            GitHub
          </Link>
          {" · "}
          <Link
            href="https://developers.cloudflare.com/agents"
            variant="inline"
          >
            Docs
          </Link>
        </div>
      </div>
    </aside>
  );
}
