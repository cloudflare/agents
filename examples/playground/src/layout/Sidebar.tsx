import {
  CaretDown,
  CaretRight,
  Cube,
  ChatDots,
  HardDrives,
  GitBranch,
  Envelope,
  Database,
  Lightning,
  Clock,
  Users,
  Cpu,
  Wrench,
  Key,
  PlayCircle,
  CheckCircle,
  Sun,
  Moon,
  Monitor,
  Signpost,
  TreeStructure,
  ChatCircle,
  Stack,
  GitMerge,
  Shield
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
    icon: <Cube size={16} />,
    items: [
      {
        label: "State",
        path: "/core/state",
        icon: <Database size={16} />
      },
      {
        label: "Callable",
        path: "/core/callable",
        icon: <Lightning size={16} />
      },
      {
        label: "Streaming",
        path: "/core/streaming",
        icon: <PlayCircle size={16} />
      },
      {
        label: "Schedule",
        path: "/core/schedule",
        icon: <Clock size={16} />
      },
      {
        label: "Connections",
        path: "/core/connections",
        icon: <Users size={16} />
      },
      {
        label: "SQL",
        path: "/core/sql",
        icon: <Database size={16} />
      },
      {
        label: "Routing",
        path: "/core/routing",
        icon: <Signpost size={16} />
      }
    ]
  },
  {
    label: "AI",
    icon: <Cpu size={16} />,
    items: [
      {
        label: "Chat",
        path: "/ai/chat",
        icon: <ChatDots size={16} />
      },
      {
        label: "Tools",
        path: "/ai/tools",
        icon: <Wrench size={16} />
      }
    ]
  },
  {
    label: "MCP",
    icon: <HardDrives size={16} />,
    items: [
      {
        label: "Server",
        path: "/mcp/server",
        icon: <HardDrives size={16} />
      },
      {
        label: "Client",
        path: "/mcp/client",
        icon: <Cpu size={16} />
      },
      {
        label: "OAuth",
        path: "/mcp/oauth",
        icon: <Key size={16} />
      }
    ]
  },
  {
    label: "Workflows",
    icon: <GitBranch size={16} />,
    items: [
      {
        label: "Basic",
        path: "/workflow/basic",
        icon: <PlayCircle size={16} />
      },
      {
        label: "Approval",
        path: "/workflow/approval",
        icon: <CheckCircle size={16} />
      }
    ]
  },
  {
    label: "Multi-Agent",
    icon: <TreeStructure size={16} />,
    items: [
      {
        label: "Supervisor",
        path: "/multi-agent/supervisor",
        icon: <Users size={16} />
      },
      {
        label: "Chat Rooms",
        path: "/multi-agent/rooms",
        icon: <ChatCircle size={16} />
      },
      {
        label: "Workers",
        path: "/multi-agent/workers",
        icon: <Stack size={16} />
      },
      {
        label: "Pipeline",
        path: "/multi-agent/pipeline",
        icon: <GitMerge size={16} />
      }
    ]
  },
  {
    label: "Email",
    icon: <Envelope size={16} />,
    items: [
      {
        label: "Receive",
        path: "/email/receive",
        icon: <Envelope size={16} />
      },
      {
        label: "Secure Replies",
        path: "/email/secure",
        icon: <Shield size={16} />
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
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-kumo-subtle hover:text-kumo-default bg-kumo-control rounded-md transition-colors"
      >
        {isOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}
        {category.icon}
        {category.label}
      </button>

      {isOpen && (
        <div className="ml-5 mt-1 space-y-0.5">
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

function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  const cycleTheme = () => {
    if (theme === "system") setTheme("light");
    else if (theme === "light") setTheme("dark");
    else setTheme("system");
  };

  const icon =
    theme === "system" ? (
      <Monitor size={16} />
    ) : theme === "light" ? (
      <Sun size={16} />
    ) : (
      <Moon size={16} />
    );

  return (
    <Button
      variant="ghost"
      size="sm"
      icon={icon}
      onClick={cycleTheme}
      title={`Theme: ${theme}`}
    >
      <span className="text-xs capitalize">{theme}</span>
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

      <div className="p-4 border-t border-kumo-line space-y-3">
        <ThemeToggle />
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
