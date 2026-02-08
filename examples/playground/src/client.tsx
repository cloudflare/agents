import "./styles.css";
import { createRoot } from "react-dom/client";
import { forwardRef } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Link as RouterLink
} from "react-router-dom";
import { LinkProvider, type LinkComponentProps } from "@cloudflare/kumo";
import { ThemeProvider } from "./hooks/useTheme";

/**
 * Adapter between Kumo's LinkProvider (to?: string) and React Router's Link (to: To).
 * Falls back to a plain <a> when `to` is not provided.
 */
const AppLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(
  ({ to, ...props }, ref) => {
    if (to) {
      return <RouterLink ref={ref} to={to} {...props} />;
    }
    // oxlint-disable-next-line jsx-a11y/anchor-has-content -- content comes from spread props
    return <a ref={ref} {...props} />;
  }
);
import { Layout } from "./layout";
import { Home } from "./pages/Home";

// Core demos
import { StateDemo } from "./demos/core/StateDemo";
import { CallableDemo } from "./demos/core/CallableDemo";
import { StreamingDemo } from "./demos/core/StreamingDemo";
import { ScheduleDemo } from "./demos/core/ScheduleDemo";
import { ConnectionsDemo } from "./demos/core/ConnectionsDemo";
import { SqlDemo } from "./demos/core/SqlDemo";
import { RoutingDemo } from "./demos/core/RoutingDemo";

// AI demos
import { ChatDemo } from "./demos/ai/ChatDemo";
import { ToolsDemo } from "./demos/ai/ToolsDemo";

// MCP demos
import { McpServerDemo } from "./demos/mcp/ServerDemo";
import { McpClientDemo } from "./demos/mcp/ClientDemo";
import { McpOAuthDemo } from "./demos/mcp/OAuthDemo";

// Workflow demos
import { WorkflowBasicDemo } from "./demos/workflow/BasicDemo";
import { WorkflowApprovalDemo } from "./demos/workflow/ApprovalDemo";

// Email demos
import { ReceiveDemo, SecureDemo } from "./demos/email";

// Multi-Agent demos
import {
  SupervisorDemo,
  ChatRoomsDemo,
  WorkersDemo,
  PipelineDemo
} from "./demos/multi-agent";

function App() {
  return (
    <ThemeProvider>
      <LinkProvider component={AppLink}>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Layout />}>
              <Route index element={<Home />} />

              {/* Core */}
              <Route path="core/state" element={<StateDemo />} />
              <Route path="core/callable" element={<CallableDemo />} />
              <Route path="core/streaming" element={<StreamingDemo />} />
              <Route path="core/schedule" element={<ScheduleDemo />} />
              <Route path="core/connections" element={<ConnectionsDemo />} />
              <Route path="core/sql" element={<SqlDemo />} />
              <Route path="core/routing" element={<RoutingDemo />} />

              {/* AI */}
              <Route path="ai/chat" element={<ChatDemo />} />
              <Route path="ai/tools" element={<ToolsDemo />} />

              {/* MCP */}
              <Route path="mcp/server" element={<McpServerDemo />} />
              <Route path="mcp/client" element={<McpClientDemo />} />
              <Route path="mcp/oauth" element={<McpOAuthDemo />} />

              {/* Workflow */}
              <Route path="workflow/basic" element={<WorkflowBasicDemo />} />
              <Route
                path="workflow/approval"
                element={<WorkflowApprovalDemo />}
              />

              {/* Multi-Agent */}
              <Route
                path="multi-agent/supervisor"
                element={<SupervisorDemo />}
              />
              <Route path="multi-agent/rooms" element={<ChatRoomsDemo />} />
              <Route path="multi-agent/workers" element={<WorkersDemo />} />
              <Route path="multi-agent/pipeline" element={<PipelineDemo />} />

              {/* Email */}
              <Route path="email/receive" element={<ReceiveDemo />} />
              <Route path="email/secure" element={<SecureDemo />} />

              {/* Fallback */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </LinkProvider>
    </ThemeProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
