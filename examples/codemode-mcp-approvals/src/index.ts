import { env } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import {
  CodemodeConnector,
  createCodemodeRuntime,
  DynamicWorkerExecutor,
  type CodemodeRuntimeHandle,
  type ConnectorTools,
  type PendingAction,
  type ProxyToolOutput,
  type ToolLogEntry
} from "@cloudflare/codemode";
import { Agent, getAgentByName } from "agents";
import {
  createMcpHandler,
  DurableObjectEventStore,
  type TransportState,
  WorkerTransport
} from "agents/mcp";
import { z } from "zod";

export { CodemodeRuntime } from "@cloudflare/codemode";

const TRANSPORT_STATE_KEY = "mcp_transport_state";

type Comment = {
  body: string;
};

type Issue = {
  id: string;
  title: string;
  comments: Comment[];
};

type MergeRequest = {
  id: string;
  title: string;
  comments: Comment[];
};

type DemoState = {
  issues: Issue[];
  mergeRequests: MergeRequest[];
};

type WorkTrackerApi = {
  state(): DemoState;
  update(state: DemoState): void;
};

type RejectedExecutionOutput = {
  status: "rejected";
  executionId: string;
  action: "accept" | "decline" | "cancel";
  pending: PendingAction;
  calls?: ToolLogEntry[];
};

type McpExecutionOutput = ProxyToolOutput | RejectedExecutionOutput;

/**
 * The connector is the permission boundary. The model only receives methods
 * listed here; protected methods carry `requiresApproval`, while comments are
 * intentionally allowed without approval.
 */
class WorkTrackerConnector extends CodemodeConnector<Env> {
  constructor(
    ctx: DurableObjectState,
    env: Env,
    private readonly api: WorkTrackerApi
  ) {
    super(ctx, env);
  }

  name() {
    return "work";
  }

  protected instructions() {
    return "Demo issue and merge-request tracker. Creating records requires approval; listing and commenting do not.";
  }

  protected tools(): ConnectorTools {
    return {
      list_issues: {
        description: "List issues and their comments.",
        inputSchema: { type: "object", properties: {} },
        execute: () => this.api.state().issues
      },
      comment_on_issue: {
        description:
          "Add a comment to an existing issue. Does not require approval.",
        inputSchema: {
          type: "object",
          properties: {
            issueId: { type: "string" },
            body: { type: "string" }
          },
          required: ["issueId", "body"],
          additionalProperties: false
        },
        execute: (args) => {
          const { issueId, body } = args as { issueId: string; body: string };
          const state = this.api.state();
          const issue = state.issues.find((item) => item.id === issueId);
          if (!issue) throw new Error(`Issue "${issueId}" not found.`);
          const next = {
            ...state,
            issues: state.issues.map((item) =>
              item.id === issueId
                ? { ...item, comments: [...item.comments, { body }] }
                : item
            )
          };
          this.api.update(next);
          return { issueId, body };
        }
      },
      create_issue: {
        description: "Create an issue. Requires user approval before it runs.",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
          additionalProperties: false
        },
        requiresApproval: true,
        execute: (args) => {
          const { title } = args as { title: string };
          const state = this.api.state();
          const issue = {
            id: `ISSUE-${state.issues.length + 1}`,
            title,
            comments: []
          };
          this.api.update({ ...state, issues: [...state.issues, issue] });
          return issue;
        }
      },
      list_merge_requests: {
        description: "List merge requests and their comments.",
        inputSchema: { type: "object", properties: {} },
        execute: () => this.api.state().mergeRequests
      },
      comment_on_merge_request: {
        description:
          "Add a comment to an existing merge request. Does not require approval.",
        inputSchema: {
          type: "object",
          properties: {
            mergeRequestId: { type: "string" },
            body: { type: "string" }
          },
          required: ["mergeRequestId", "body"],
          additionalProperties: false
        },
        execute: (args) => {
          const { mergeRequestId, body } = args as {
            mergeRequestId: string;
            body: string;
          };
          const state = this.api.state();
          const mergeRequest = state.mergeRequests.find(
            (item) => item.id === mergeRequestId
          );
          if (!mergeRequest) {
            throw new Error(`Merge request "${mergeRequestId}" not found.`);
          }
          const next = {
            ...state,
            mergeRequests: state.mergeRequests.map((item) =>
              item.id === mergeRequestId
                ? { ...item, comments: [...item.comments, { body }] }
                : item
            )
          };
          this.api.update(next);
          return { mergeRequestId, body };
        }
      },
      create_merge_request: {
        description:
          "Create a merge request. Requires user approval before it runs.",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
          additionalProperties: false
        },
        requiresApproval: true,
        execute: (args) => {
          const { title } = args as { title: string };
          const state = this.api.state();
          const mergeRequest = {
            id: `MR-${state.mergeRequests.length + 1}`,
            title,
            comments: []
          };
          this.api.update({
            ...state,
            mergeRequests: [...state.mergeRequests, mergeRequest]
          });
          return mergeRequest;
        }
      }
    };
  }
}

function textResult(value: unknown, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ],
    ...(isError ? { isError: true } : {})
  };
}

function approvalMessage(action: PendingAction): string {
  return [
    `Allow ${action.connector}.${action.method}?`,
    "",
    "Arguments:",
    JSON.stringify(action.args, null, 2)
  ].join("\n");
}

export class CodemodeMcp extends Agent<Env, DemoState> {
  initialState: DemoState = {
    issues: [
      {
        id: "ISSUE-1",
        title: "Code Mode permission demo",
        comments: []
      }
    ],
    mergeRequests: [
      {
        id: "MR-1",
        title: "Add durable Code Mode approvals",
        comments: []
      }
    ]
  };

  server = new McpServer(
    {
      name: "Durable Code Mode approvals",
      version: "1.0.0"
    },
    {
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator()
    }
  );

  transport = new WorkerTransport({
    sessionIdGenerator: () => this.name,
    storage: {
      get: () => this.ctx.storage.kv.get<TransportState>(TRANSPORT_STATE_KEY),
      set: (state) =>
        this.ctx.storage.kv.put<TransportState>(TRANSPORT_STATE_KEY, state)
    },
    eventStore: new DurableObjectEventStore(this.ctx.storage)
  });

  onStart() {
    this.server.registerTool(
      "search",
      {
        description:
          "Search the Code Mode operation catalog, or describe one exact result. " +
          "Call with query first, then pass a result path as target for its types.",
        inputSchema: {
          query: z
            .string()
            .optional()
            .describe("Short intent phrase to search"),
          target: z
            .string()
            .optional()
            .describe("Exact connector or connector.method path to describe")
        },
        annotations: { readOnlyHint: true }
      },
      async ({ query, target }) => {
        if (target) return textResult(await this.runtime().describe(target));
        if (query) return textResult(await this.runtime().search(query));
        return textResult(
          {
            error: "Provide either a query to search or a target to describe."
          },
          true
        );
      }
    );

    this.server.registerTool(
      "execute",
      {
        description: [
          "Execute JavaScript with the durable Code Mode runtime.",
          "Use search first to discover exact methods and input types.",
          "Code must be an async arrow function. Available globals: work and codemode.",
          "Protected connector calls pause, elicit user approval, then resume by replay."
        ].join(" "),
        inputSchema: {
          code: z
            .string()
            .describe("JavaScript async arrow function to execute")
        }
      },
      async ({ code }, extra) => {
        const outcome = await this.keepAliveWhile(() =>
          this.executeWithApprovals(code, extra.requestId, extra.signal)
        );
        return textResult(outcome, outcome.status === "error");
      }
    );
  }

  private runtime(): CodemodeRuntimeHandle {
    const connector = new WorkTrackerConnector(this.ctx, this.env, {
      state: () => this.state,
      update: (state) => this.setState(state)
    });

    return createCodemodeRuntime({
      ctx: this.ctx,
      executor: new DynamicWorkerExecutor({ loader: this.env.LOADER }),
      connectors: [connector],
      name: "mcp"
    });
  }

  private async executeWithApprovals(
    code: string,
    relatedRequestId: string | number,
    signal: AbortSignal
  ): Promise<McpExecutionOutput> {
    const runtime = this.runtime();
    let outcome = await runtime.execute({ code });

    while (outcome.status === "paused") {
      const pending = outcome.pending[0];
      if (!pending) {
        return {
          status: "error",
          executionId: outcome.executionId,
          error: "Execution paused without a pending action.",
          calls: outcome.calls
        };
      }

      const supportsFormElicitation =
        this.server.server.getClientCapabilities()?.elicitation?.form !==
        undefined;
      if (!supportsFormElicitation) {
        await runtime.reject({
          executionId: outcome.executionId,
          seq: pending.seq
        });
        return {
          status: "error",
          executionId: outcome.executionId,
          error:
            "This action requires approval, but the MCP client did not advertise form-mode elicitation support.",
          calls: outcome.calls
        };
      }

      let response;
      try {
        response = await this.server.server.elicitInput(
          {
            mode: "form",
            message: approvalMessage(pending),
            requestedSchema: {
              type: "object",
              properties: {
                approved: {
                  type: "boolean",
                  title: "Approve action",
                  description: `Allow ${pending.connector}.${pending.method} to run?`,
                  default: false
                }
              },
              required: ["approved"]
            }
          },
          { relatedRequestId, signal }
        );
      } catch (error) {
        await runtime.reject({
          executionId: outcome.executionId,
          seq: pending.seq
        });
        return {
          status: "error",
          executionId: outcome.executionId,
          error:
            error instanceof Error
              ? `Approval failed: ${error.message}`
              : "Approval failed.",
          calls: outcome.calls
        };
      }

      if (response.action !== "accept" || response.content?.approved !== true) {
        const rejected = await runtime.reject({
          executionId: outcome.executionId,
          seq: pending.seq
        });
        if (!rejected) {
          return {
            status: "error",
            executionId: outcome.executionId,
            error: "The execution was no longer awaiting this approval.",
            calls: outcome.calls
          };
        }
        return {
          status: "rejected",
          executionId: outcome.executionId,
          action: response.action,
          pending,
          calls: outcome.calls
        };
      }

      outcome = await runtime.approve({ executionId: outcome.executionId });
    }

    return outcome;
  }

  async onMcpRequest(request: Request): Promise<Response> {
    const handler = createMcpHandler(this.server, {
      route: "/mcp",
      transport: this.transport
    });
    return handler(request, this.env, {} as ExecutionContext);
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/mcp") {
      return new Response("Not found. Connect an MCP client to /mcp.", {
        status: 404
      });
    }

    const sessionId =
      request.headers.get("mcp-session-id") ?? crypto.randomUUID();
    const agent = await getAgentByName(env.CodemodeMcp, sessionId);
    return agent.onMcpRequest(request);
  }
};
