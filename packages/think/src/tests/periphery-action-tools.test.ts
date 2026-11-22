import type { UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  approvedActionInputs,
  compileActionTools,
  createActionAbortSignal,
  normalizeActionAuthorization,
  prepareActionOutputForModel,
  type ActionToolHost
} from "../action-tools";
import { action, type CompiledActionMetadata } from "../actions";
import type { Think } from "../think";

function host(overrides: Partial<ActionToolHost> = {}): ActionToolHost {
  return {
    agent: {} as Think,
    env: () => ({}) as Cloudflare.Env,
    requestId: () => "req",
    isApproved: () => false,
    grantedPermissions: () => undefined,
    authorizeAction: () => true,
    recordApprovalDescriptor: vi.fn(),
    recordReplyAttachment: vi.fn(),
    runLedgered: async ({ runAction }) => runAction(),
    parkDurablePause: ({ toolName }) => ({ status: "paused", toolName }),
    ...overrides
  };
}

type Execute = (input: unknown, options: unknown) => Promise<unknown>;
const run = (t: unknown, input: unknown) =>
  (t as { execute: Execute }).execute(input, {
    toolCallId: "c1",
    messages: []
  });

describe("compileActionTools", () => {
  it("rejects an entry not made with action()", () => {
    expect(() =>
      compileActionTools({ bad: {} as never }, host(), new Map())
    ).toThrow(/must be created with action\(\)/);
  });

  it("runs a server action through the ledger", async () => {
    const runLedgered = vi.fn(async ({ runAction }) => runAction());
    const tools = compileActionTools(
      {
        add: action({
          description: "add",
          inputSchema: {} as never,
          execute: (input: { a: number }) => input.a + 1
        })
      },
      host({ runLedgered }),
      new Map()
    );
    expect(await run(tools.add, { a: 1 })).toBe(2);
    expect(runLedgered).toHaveBeenCalledOnce();
  });

  it("returns the authorization envelope when denied", async () => {
    const tools = compileActionTools(
      {
        add: action({
          description: "add",
          inputSchema: {} as never,
          permissions: ["math"],
          execute: () => 1
        })
      },
      host({ authorizeAction: () => ({ allowed: false, reason: "no" }) }),
      new Map()
    );
    const output = (await run(tools.add, {})) as { error: { message: string } };
    expect(output.error.message).toContain("no");
  });

  it("records metadata for gated actions and parks durable pauses", async () => {
    const metadata = new Map<string, CompiledActionMetadata>();
    const tools = compileActionTools(
      {
        send: action({
          description: "send",
          inputSchema: {} as never,
          kind: "durable-pause",
          approvalRisk: "high",
          execute: () => "sent"
        })
      },
      host(),
      metadata
    );
    expect(metadata.get("send")).toMatchObject({
      kind: "durable-pause",
      risk: "high"
    });
    expect(await run(tools.send, {})).toEqual({
      status: "paused",
      toolName: "send"
    });
  });
});

describe("action helpers", () => {
  it("normalizes authorization decisions", () => {
    expect(normalizeActionAuthorization(false)).toEqual({ allowed: false });
    expect(
      normalizeActionAuthorization({ allowed: true, grantedPermissions: ["a"] })
    ).toEqual({ allowed: true, grantedPermissions: ["a"] });
  });

  it("reads approved inputs from the transcript", () => {
    const messages = [
      {
        id: "a",
        role: "assistant",
        parts: [
          {
            type: "tool-send",
            toolCallId: "c1",
            input: { raw: 1 },
            approval: {
              approved: true,
              descriptor: { action: "send", input: { to: "x" } }
            }
          },
          {
            type: "tool-send",
            toolCallId: "c2",
            approval: { approved: false, descriptor: { action: "send" } }
          }
        ]
      }
    ] as unknown as UIMessage[];
    expect([...approvedActionInputs(messages)]).toEqual([["c1", { to: "x" }]]);
  });

  it("truncates large outputs for the model", () => {
    const text = prepareActionOutputForModel("x".repeat(30_000)) as string;
    expect(text).toContain("[truncated 10000 chars]");
    const object = prepareActionOutputForModel({ big: "y".repeat(30_000) }) as {
      truncated: boolean;
    };
    expect(object.truncated).toBe(true);
    expect(prepareActionOutputForModel({ a: 1 })).toEqual({ a: 1 });
  });

  it("aborts on timeout", async () => {
    const { signal, cleanup } = createActionAbortSignal(undefined, 5);
    await new Promise((r) => setTimeout(r, 20));
    expect(signal.aborted).toBe(true);
    cleanup();
  });
});

describe("action context bindings", () => {
  it("reads the agent's env when the action runs, not when it compiles", async () => {
    let env = { STAGE: "first" } as unknown as Cloudflare.Env;
    const tools = compileActionTools(
      {
        stage: action({
          description: "stage",
          inputSchema: {} as never,
          execute: (_input: unknown, ctx) =>
            (ctx.env as unknown as { STAGE: string }).STAGE
        })
      },
      host({ env: () => env }),
      new Map()
    );
    env = { STAGE: "second" } as unknown as Cloudflare.Env;
    expect(await run(tools.stage, {})).toBe("second");
  });
});
