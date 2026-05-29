/**
 * Model-facing proxy tool.
 *
 * One AI SDK tool with `{ code: string }`. Each connector gets a
 * CodemodeSession facet for pending-action storage. Approval checks
 * happen in the binding wrapper, not the session — so the session
 * is a pure state store that survives DO hibernation.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";
import type { Executor, ResolvedProvider, ConnectorBinding } from "./executor";
import { createRuntime } from "./runtime";
import type { CodemodeConnector, ConnectorDescription } from "./connectors";
import { searchConnectors, describeTarget } from "./connectors";
import {
  CodemodeSession,
  type ActionResult,
  type PendingAction
} from "./session";
import type { CodemodeSkill, CodemodeSkillSource } from "./skills";
import type { CodeOutput } from "./shared";
import type { ToolAnnotations } from "./connectors/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ProxyToolInput = { code: string };
export type ProxyToolOutput = CodeOutput;

export type CreateProxyToolOptions = {
  ctx: DurableObjectState;
  connectors: CodemodeConnector[];
  executor: Executor;
  skills?: CodemodeSkillSource[];
  description?: string;
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type SessionEntry = {
  name: string;
  connector: CodemodeConnector;
  session: Fetcher<CodemodeSession>;
  description: ConnectorDescription;
  annotations: Record<string, ToolAnnotations>;
};

// ---------------------------------------------------------------------------
// Session helpers — wrap the Fetcher<CodemodeSession> RPC boundary once
// ---------------------------------------------------------------------------

async function sessionListPending(
  session: Fetcher<CodemodeSession>
): Promise<PendingAction[]> {
  return (await session.listPendingActions()) as unknown as PendingAction[];
}

async function sessionStore(
  session: Fetcher<CodemodeSession>,
  action: PendingAction
): Promise<void> {
  await session.storePendingAction(action);
}

async function sessionApply(
  session: Fetcher<CodemodeSession>,
  connector: CodemodeConnector,
  actionId: string
): Promise<unknown> {
  const pending = (await session.getPendingAction(
    actionId
  )) as unknown as PendingAction | null;
  if (!pending) throw new Error(`No pending action: ${actionId}`);
  const result = await connector.executeTool(pending.method, pending.args);
  await session.deletePendingAction(actionId);
  return result;
}

// ---------------------------------------------------------------------------
// Session spawning
// ---------------------------------------------------------------------------

async function spawnSessions(
  ctx: DurableObjectState,
  connectors: CodemodeConnector[]
): Promise<SessionEntry[]> {
  const entries: SessionEntry[] = [];

  for (const connector of connectors) {
    const name = connector.name();
    const description = await connector.describe();

    const session = ctx.facets.get(`codemode:${name}`, () => ({
      class: CodemodeSession as unknown as DurableObjectClass
    })) as unknown as Fetcher<CodemodeSession>;

    entries.push({
      name,
      connector,
      session,
      description,
      annotations: connector.annotations()
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Connector binding — routes sandbox calls through approval checks
// ---------------------------------------------------------------------------

let nextActionId = 0;

function buildConnectorBindings(entries: SessionEntry[]): ConnectorBinding[] {
  return entries.map((entry) => ({
    name: entry.name,
    binding: {
      callTool: async (method: string, args: unknown): Promise<unknown> => {
        const annotation = entry.annotations[method];

        // Observation or no annotation — execute immediately
        if (!annotation?.requiresApproval) {
          return entry.connector.executeTool(method, args);
        }

        // Action requiring approval — simulate and store pending
        const actionId = `action_${++nextActionId}`;
        const provisionalResult = await entry.connector.simulate(method, args);

        await sessionStore(entry.session, {
          id: actionId,
          connector: entry.name,
          method,
          args,
          description: annotation.approvalDescription,
          provisionalResult,
          createdAt: Date.now()
        });

        return provisionalResult;
      }
    }
  }));
}

// ---------------------------------------------------------------------------
// Skill loading
// ---------------------------------------------------------------------------

async function loadAllSkills(
  sources: CodemodeSkillSource[]
): Promise<CodemodeSkill[]> {
  const all: CodemodeSkill[] = [];
  for (const source of sources) {
    all.push(...(await source.list()));
  }
  return all;
}

// ---------------------------------------------------------------------------
// Platform provider functions — each is a named, focused function
// ---------------------------------------------------------------------------

function platformSearch(
  descriptions: ConnectorDescription[],
  skills: CodemodeSkill[]
) {
  return async (query: unknown) =>
    searchConnectors(String(query), descriptions, skills);
}

function platformDescribe(
  descriptions: ConnectorDescription[],
  skills: CodemodeSkill[]
) {
  return async (target: unknown) =>
    describeTarget(String(target), descriptions, skills);
}

function platformConnectors(descriptions: ConnectorDescription[]) {
  return async () =>
    descriptions.map((d) => ({
      name: d.name,
      instructions: d.instructions,
      methodCount: Object.keys(d.descriptors).length
    }));
}

function platformRun(
  skills: CodemodeSkill[],
  bindings: ConnectorBinding[],
  runtime: ReturnType<typeof createRuntime>
) {
  return async (...args: unknown[]) => {
    const skill = skills.find((s) => s.name === String(args[0]));
    if (!skill) return { error: `Skill "${args[0]}" not found.` };
    const result = await runtime.execute({
      code: `async () => {\n  const skill = (${skill.code});\n  return await skill(${JSON.stringify(args[1])});\n}`,
      providers: [],
      connectors: bindings
    });
    return result.result;
  };
}

function platformPending(entries: SessionEntry[]) {
  return async () => {
    const all: PendingAction[] = [];
    for (const entry of entries) {
      const pending = await sessionListPending(entry.session);
      for (const action of pending) {
        action.connector = entry.name;
      }
      all.push(...pending);
    }
    return all;
  };
}

function createPlatformProvider(
  entries: SessionEntry[],
  skills: CodemodeSkill[],
  bindings: ConnectorBinding[],
  runtime: ReturnType<typeof createRuntime>
): ResolvedProvider {
  const descriptions = entries.map((e) => e.description);
  return {
    name: "codemode",
    fns: {
      search: platformSearch(descriptions, skills),
      describe: platformDescribe(descriptions, skills),
      connectors: platformConnectors(descriptions),
      run: platformRun(skills, bindings, runtime),
      pending: platformPending(entries)
    }
  };
}

// ---------------------------------------------------------------------------
// Tool description
// ---------------------------------------------------------------------------

function buildDescription(
  connectors: CodemodeConnector[],
  hasSkills: boolean,
  customDescription?: string
): string {
  if (customDescription) return customDescription;

  const namespaces = connectors.map((c) => `- \`${c.name()}\``).join("\n");

  const lines = [
    "Execute TypeScript in a sandbox with access to connector SDKs.",
    "",
    "## Workflow",
    "",
    '1. `const matches = await codemode.search("short intent phrase");`',
    "2. `const docs = await codemode.describe(matches.results[0].path);`",
    "3. Call the method: `await <connector>.<method>(args);`",
    "",
    "## Rules",
    "",
    "- `codemode.search(query)` returns ranked matches.",
    '- `codemode.describe("connector.method")` returns TypeScript type declarations.',
    "- `codemode.connectors()` lists available connectors.",
    "- `codemode.pending()` lists actions awaiting approval.",
    "- Some methods require approval. They return a provisional result with `__pending: true`. The real action executes after approval.",
    "- Connector SDKs are available as globals named after each connector.",
    "- Do not use `fetch` — use connector SDKs."
  ];

  if (hasSkills) {
    lines.push(
      '- `codemode.run("skill-name", input)` executes a reusable skill.'
    );
  }

  lines.push("", "## Available connectors", "", namespaces);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// createProxyTool
// ---------------------------------------------------------------------------

const proxySchema = z.object({ code: z.string() });

export function createProxyTool(
  options: CreateProxyToolOptions
): Tool<ProxyToolInput, ProxyToolOutput> {
  const runtime = createRuntime(options.executor);
  const connectors = options.connectors;
  const skillSources = options.skills ?? [];

  for (const connector of connectors) {
    if (connector.name() === "codemode") {
      throw new Error(
        'Connector name "codemode" is reserved for the codemode platform SDK.'
      );
    }
  }

  // Cached across tool calls
  let setupPromise: Promise<SessionEntry[]> | undefined;
  let skillsPromise: Promise<CodemodeSkill[]> | undefined;

  function getSessions() {
    return (setupPromise ??= spawnSessions(options.ctx, connectors));
  }
  function getSkills() {
    return (skillsPromise ??= loadAllSkills(skillSources));
  }

  return tool({
    description: buildDescription(
      connectors,
      skillSources.length > 0,
      options.description
    ),
    inputSchema: proxySchema,
    execute: async ({ code }) => {
      const [entries, skills] = await Promise.all([getSessions(), getSkills()]);

      const bindings = buildConnectorBindings(entries);
      const platformProvider = createPlatformProvider(
        entries,
        skills,
        bindings,
        runtime
      );

      return runtime.execute({
        code,
        providers: [platformProvider],
        connectors: bindings
      });
    }
  });
}
