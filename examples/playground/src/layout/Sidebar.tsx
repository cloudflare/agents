import {
  ChevronDown,
  ChevronRight,
  Box,
  MessageSquare,
  Server,
  GitBranch,
  Mail,
  Database,
  Zap,
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
  Route,
  Network,
  MessageCircle,
  Layers,
  GitMerge,
  Shield
} from "lucide-react";
import { useState } from "react";
import { NavLink } from "react-router-dom";
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
    icon: <Box className="w-4 h-4" />,
    items: [
      {
        label: "State",
        path: "/core/state",
        icon: <Database className="w-4 h-4" />
      },
      {
        label: "Callable",
        path: "/core/callable",
        icon: <Zap className="w-4 h-4" />
      },
      {
        label: "Streaming",
        path: "/core/streaming",
        icon: <PlayCircle className="w-4 h-4" />
      },
      {
        label: "Schedule",
        path: "/core/schedule",
        icon: <Clock className="w-4 h-4" />
      },
      {
        label: "Connections",
        path: "/core/connections",
        icon: <Users className="w-4 h-4" />
      },
      {
        label: "SQL",
        path: "/core/sql",
        icon: <Database className="w-4 h-4" />
      },
      {
        label: "Routing",
        path: "/core/routing",
        icon: <Route className="w-4 h-4" />
      }
    ]
  },
  {
    label: "AI",
    icon: <Cpu className="w-4 h-4" />,
    items: [
      {
        label: "Chat",
        path: "/ai/chat",
        icon: <MessageSquare className="w-4 h-4" />
      },
      {
        label: "Tools",
        path: "/ai/tools",
        icon: <Wrench className="w-4 h-4" />
      }
    ]
  },
  {
    label: "MCP",
    icon: <Server className="w-4 h-4" />,
    items: [
      {
        label: "Server",
        path: "/mcp/server",
        icon: <Server className="w-4 h-4" />
      },
      {
        label: "Client",
        path: "/mcp/client",
        icon: <Cpu className="w-4 h-4" />
      },
      { label: "OAuth", path: "/mcp/oauth", icon: <Key className="w-4 h-4" /> }
    ]
  },
  {
    label: "Workflows",
    icon: <GitBranch className="w-4 h-4" />,
    items: [
      {
        label: "Basic",
        path: "/workflow/basic",
        icon: <PlayCircle className="w-4 h-4" />
      },
      {
        label: "Approval",
        path: "/workflow/approval",
        icon: <CheckCircle className="w-4 h-4" />
      }
    ]
  },
  {
    label: "Multi-Agent",
    icon: <Network className="w-4 h-4" />,
    items: [
      {
        label: "Supervisor",
        path: "/multi-agent/supervisor",
        icon: <Users className="w-4 h-4" />
      },
      {
        label: "Chat Rooms",
        path: "/multi-agent/rooms",
        icon: <MessageCircle className="w-4 h-4" />
      },
      {
        label: "Workers",
        path: "/multi-agent/workers",
        icon: <Layers className="w-4 h-4" />
      },
      {
        label: "Pipeline",
        path: "/multi-agent/pipeline",
        icon: <GitMerge className="w-4 h-4" />
      }
    ]
  },
  {
    label: "Email",
    icon: <Mail className="w-4 h-4" />,
    items: [
      {
        label: "Receive",
        path: "/email/receive",
        icon: <Mail className="w-4 h-4" />
      },
      {
        label: "Secure Replies",
        path: "/email/secure",
        icon: <Shield className="w-4 h-4" />
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
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 hover:text-black dark:hover:text-white bg-neutral-100 dark:bg-neutral-800 rounded-md transition-colors"
      >
        {isOpen ? (
          <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronRight className="w-3 h-3" />
        )}
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
                `sidebar-item ${isActive ? "sidebar-item-active" : ""}`
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

  return (
    <button
      type="button"
      onClick={cycleTheme}
      className="flex items-center gap-2 p-2 rounded-md hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors"
      title={`Theme: ${theme}`}
    >
      {theme === "system" && <Monitor className="w-4 h-4" />}
      {theme === "light" && <Sun className="w-4 h-4" />}
      {theme === "dark" && <Moon className="w-4 h-4" />}
      <span className="text-xs capitalize">{theme}</span>
    </button>
  );
}

export function Sidebar() {
  return (
    <aside className="w-56 h-full border-r border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 flex flex-col">
      <div className="p-4 border-b border-neutral-200 dark:border-neutral-700">
        <h1 className="font-bold text-lg">Agents SDK</h1>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Playground
        </p>
      </div>

      <nav className="flex-1 overflow-y-auto p-2">
        {navigation.map((category) => (
          <CategorySection key={category.label} category={category} />
        ))}
      </nav>

      <div className="p-4 border-t border-neutral-200 dark:border-neutral-700 space-y-3">
        <ThemeToggle />
        <div className="text-xs text-neutral-500 dark:text-neutral-400">
          <a
            href="https://github.com/cloudflare/agents"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-black dark:hover:text-white transition-colors"
          >
            GitHub
          </a>
          {" · "}
          <a
            href="https://developers.cloudflare.com/agents"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-black dark:hover:text-white transition-colors"
          >
            Docs
          </a>
        </div>
      </div>
    </aside>
  );
}
