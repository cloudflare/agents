import type { ClientCapabilities } from "@modelcontextprotocol/client";
import {
  elicitationCapabilitiesFromHandlers,
  type MCPElicitationHandlers
} from "./connection";
import type { McpClientContext } from "./context";
import type { MCPClientElicitationHandlers } from "./types";

/**
 * The manager's elicitation handlers, held in memory only, and what they
 * make each connection advertise. Advertised modes are stamped on every
 * stored server so a restore re-advertises them before the handlers are
 * configured again.
 */
export class ElicitationHandlers {
  private handlers: MCPClientElicitationHandlers | undefined;

  constructor(private readonly ctx: McpClientContext) {}

  /** Whether any handler is configured. */
  get configured(): boolean {
    return this.handlers !== undefined;
  }

  /** Replace the handlers and apply them to every live connection. */
  configure(handlers: MCPClientElicitationHandlers | undefined): void {
    this.handlers =
      handlers && (handlers.form || handlers.url) ? handlers : undefined;
    this.ctx.store.stampCapabilities(this.capabilities());
    for (const [id, connection] of Object.entries(this.ctx.connections)) {
      connection.configureElicitationHandlers(this.scopedTo(id));
    }
  }

  /** Client capabilities advertised from the configured handlers. */
  capabilities(): ClientCapabilities | undefined {
    const elicitation = elicitationCapabilitiesFromHandlers(this.handlers);
    return elicitation ? { elicitation } : undefined;
  }

  /**
   * The handlers bound to one server id. Undefined when none are configured,
   * so the connection keeps its default throwing behaviour.
   */
  scopedTo(serverId: string): MCPElicitationHandlers | undefined {
    const handlers = this.handlers;
    if (!handlers) return undefined;
    const { form, url } = handlers;
    return {
      form: form
        ? (request, signal) =>
            signal ? form(request, serverId, signal) : form(request, serverId)
        : undefined,
      url: url
        ? (request, signal) =>
            signal ? url(request, serverId, signal) : url(request, serverId)
        : undefined
    };
  }
}
