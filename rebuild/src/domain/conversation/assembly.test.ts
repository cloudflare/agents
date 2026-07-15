import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMemoryKeyValueStore } from "../../adapters/memory/store.js";
import { createTestClock } from "../../adapters/memory/clock.js";
import { defaultIdSource } from "../../kernel/ids.js";
import { createSession, type Session } from "../session/session.js";
import {
  createSkillRegistry,
  fromManifest,
  type SkillRegistry
} from "../skills/skills.js";
import type { ChannelPolicy } from "../channels/channels.js";
import type { ToolSet } from "../tools/types.js";
import { assembleTurn } from "./assembly.js";

function makeSession(systemPrompt = "You are a test assistant."): Session {
  const store = createMemoryKeyValueStore();
  const clock = createTestClock();
  return createSession(
    { store, clock, ids: defaultIdSource },
    {
      sessionId: "main",
      blocks: [
        { label: "instructions", provider: { get: async () => systemPrompt } }
      ]
    }
  );
}

async function emptySkills(): Promise<SkillRegistry> {
  return createSkillRegistry([]);
}

const clock = createTestClock();
const noPolicy: ChannelPolicy = {};

describe("assembleTurn", () => {
  it("assembles the frozen session prompt with no extras when there's nothing else to add", async () => {
    const session = makeSession("Base prompt.");
    const skills = await emptySkills();

    const result = await assembleTurn({
      session,
      skills,
      policy: noPolicy,
      actions: {},
      userTools: {},
      clock
    });

    expect(result.system).toBe("INSTRUCTIONS\n[readonly]\nBase prompt.");
    expect(result.tools.tools).toEqual({});
  });

  it("appends channel instructions, skills catalog, and the capability block in order, blank-line joined", async () => {
    const session = makeSession("Base prompt.");
    const skills = await createSkillRegistry([
      fromManifest([
        {
          name: "s1",
          description: "skill one",
          instructions: "do things",
          resources: {}
        }
      ])
    ]);
    const workspaceTools: ToolSet = {
      read: {
        description: "reads",
        inputSchema: z.object({}),
        metadata: { capability: "workspace" }
      }
    };

    const result = await assembleTurn({
      session,
      skills,
      policy: { instructions: "Be terse." },
      workspaceTools,
      actions: {},
      userTools: {},
      clock
    });

    const segments = result.system.split("\n\n");
    expect(segments[0]).toBe("INSTRUCTIONS\n[readonly]\nBase prompt.");
    expect(segments[1]).toBe("Be terse.");
    expect(segments.some((s) => s.includes("s1"))).toBe(true); // skills catalog
    expect(segments.some((s) => s.includes("workspace"))).toBe(true); // capability block
  });

  it("drops empty segments instead of leaving blank joins", async () => {
    const session = makeSession("Base prompt.");
    const skills = await emptySkills();

    const result = await assembleTurn({
      session,
      skills,
      policy: {},
      actions: {},
      userTools: {},
      clock
    });

    expect(result.system).toBe("INSTRUCTIONS\n[readonly]\nBase prompt.");
    expect(result.system.includes("\n\n\n")).toBe(false);
  });

  it("merges tools in precedence order: builtin < external < actions < user", async () => {
    const session = makeSession();
    const skills = await emptySkills();
    const schema = z.object({});

    const result = await assembleTurn({
      session,
      skills,
      policy: {},
      workspaceTools: {
        shared: {
          description: "workspace",
          inputSchema: schema,
          execute: () => "workspace"
        }
      },
      fetchTools: {
        shared: {
          description: "external",
          inputSchema: schema,
          execute: () => "external"
        }
      },
      actions: {
        shared: {
          description: "actions",
          inputSchema: schema,
          execute: () => "actions"
        }
      },
      userTools: {
        shared: {
          description: "user",
          inputSchema: schema,
          execute: () => "user"
        }
      },
      clock
    });

    expect(result.tools.tools.shared?.description).toBe("user");
  });

  it("merges MCP tools into the external bucket with fetch tools", async () => {
    const session = makeSession();
    const skills = await emptySkills();
    const schema = z.object({});

    const result = await assembleTurn({
      session,
      skills,
      policy: {},
      fetchTools: {
        shared: {
          description: "fetch",
          inputSchema: schema,
          execute: () => "fetch"
        }
      },
      mcpTools: {
        shared: {
          description: "mcp",
          inputSchema: schema,
          execute: () => "mcp"
        }
      },
      actions: {},
      userTools: {},
      clock
    });

    expect(result.tools.tools.shared?.description).toBe("mcp");
  });

  it("adds a client tool only when its name doesn't collide with a server-sourced tool", async () => {
    const session = makeSession();
    const skills = await emptySkills();
    const schema = z.object({});

    const result = await assembleTurn({
      session,
      skills,
      policy: {},
      userTools: {
        serverTool: {
          description: "server",
          inputSchema: schema,
          execute: () => "server"
        }
      },
      clientTools: {
        serverTool: { description: "client collision", inputSchema: schema },
        clientOnly: { description: "client-only", inputSchema: schema }
      },
      actions: {},
      clock
    });

    expect(result.tools.tools.serverTool?.description).toBe("server"); // server wins
    expect(result.tools.tools.clientOnly?.description).toBe("client-only");
  });

  it("applies the channel policy's tool filter (remove-only)", async () => {
    const session = makeSession();
    const skills = await emptySkills();
    const schema = z.object({});

    const result = await assembleTurn({
      session,
      skills,
      policy: {
        toolFilter: (all) =>
          Object.fromEntries(
            Object.entries(all).filter(([name]) => name !== "blocked")
          )
      },
      userTools: {
        blocked: {
          description: "blocked",
          inputSchema: schema,
          execute: () => "x"
        },
        allowed: {
          description: "allowed",
          inputSchema: schema,
          execute: () => "y"
        }
      },
      actions: {},
      clock
    });

    expect(result.tools.tools.blocked).toBeUndefined();
    expect(result.tools.tools.allowed).toBeDefined();
  });
});
