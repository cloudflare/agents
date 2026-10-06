import {
  Type,
  type ImageContent,
  type TextContent,
  type ToolCall,
  type ToolResultMessage
} from "@earendil-works/pi-ai";
import {
  hook,
  ToolTask,
  type Extension as PiExtension,
  type PromptSection,
  type Registry,
  type ToolExecutionResult,
  type ToolRegistration
} from "@earendil-works/pi-durable";
import type {
  Extension,
  ExtensionFeature,
  Tool,
  ToolContentPart,
  ToolResult
} from "../extensions/extension";
import {
  ExtensionHost,
  type ExtensionAlreadyInstalled,
  type ExtensionReport,
  type ExtensionSetupFailed,
  type ExtensionSnapshot
} from "../extensions/host";
import { formatIssues, type JsonObject } from "../extensions/schema";
import { resolveSkillSources, skillsFingerprint } from "./skills";

/** Everything the portable format supports, pi-durable honours. */
const PI_FEATURES: readonly ExtensionFeature[] = [
  "tool",
  "tool.execute.before",
  "tool.execute.after",
  "instructions",
  "skill"
];

/** `piExtensions`'s options. */
export type PiExtensionsOptions = {
  /** The registry the harness factory opens pi with. */
  readonly registry: Registry;
  /** Portable extensions, in order. */
  readonly extensions: readonly Extension[];
  /**
   * The pi extension everything is installed as. Default
   * `"agents.extensions"`. Conversations select it by this name.
   */
  readonly name?: string;
  /** Failures that do not fail an operation. Default `console.warn`. */
  readonly onReport?: (report: ExtensionReport) => void;
};

/** What `piExtensions` returns. */
export type PiExtensions = {
  /** Add or remove extensions at runtime; pi sees the change at once. */
  readonly host: ExtensionHost;
  /** Extensions whose setup failed; they are not installed. */
  readonly failures: readonly (
    | ExtensionAlreadyInstalled
    | ExtensionSetupFailed
  )[];
};

/**
 * Run portable extensions on pi-durable. Call it in the harness factory,
 * before `Harness.open`, with the registry pi opens with.
 *
 * Every rebuild is installed on the registry as one pi extension: the
 * tools, one system prompt section per `instructions` key, the skill
 * activation tools and catalog, and a hook on pi's tool task that runs the
 * `execute.before` and `execute.after` hooks. pi resolves tools at every
 * call, so a rebuild applies to the next model request and the next tool
 * call, mid-run included.
 *
 * ```ts
 * harness: async ({ storage, context }) => {
 *   const registry = createRegistry();
 *   const { failures } = await piExtensions({ registry, extensions });
 *   if (failures.length > 0) throw new AggregateError(failures);
 *   return Harness.open(storage, { models, registry }, context);
 * }
 * ```
 *
 * @param options - The registry and extensions.
 * @returns The running host, and any extensions that failed to set up.
 */
export async function piExtensions(
  options: PiExtensionsOptions
): Promise<PiExtensions> {
  const name = options.name ?? "agents.extensions";
  const skills = skillCache();
  // The hook is built once; it reads the host, which is always current.
  let host: ExtensionHost | undefined;
  const toolHook = hook(ToolTask, {
    async beforeTool(call, api) {
      if (!host?.hooks("execute.before")) return undefined;
      const event = await host.beforeTool({
        tool: call.name,
        session: String(api.conversationId),
        callId: call.id,
        input: portableInput(call.arguments)
      });
      if (event.block !== undefined) return { block: event.block };
      return { arguments: event.input };
    },
    async afterTool(call, result, api) {
      if (!host?.hooks("execute.after")) return undefined;
      const original = fromPiResult(result);
      const event = await host.afterTool({
        tool: call.name,
        session: String(api.conversationId),
        callId: call.id,
        input: portableInput(call.arguments),
        result: original
      });
      if (event.result === original) return undefined;
      return {
        ...result,
        content: toPiContent(event.result.content),
        isError: event.result.isError ?? false
      };
    }
  });

  const install = async (snapshot: ExtensionSnapshot) => {
    const resolved = await skills(snapshot);
    const extension: PiExtension = {
      name,
      tools: [...snapshot.tools.map(toPiTool), ...resolved.tools],
      sections: [
        ...snapshot.instructions.map(
          ({ key, text }): PromptSection => ({ key, render: () => text })
        ),
        ...(resolved.catalog === null
          ? []
          : [{ key: "skills", render: () => resolved.catalog ?? undefined }])
      ],
      hooks: [toolHook]
    };
    options.registry.install(extension);
  };

  host = new ExtensionHost({
    harness: "pi",
    features: PI_FEATURES,
    onPublish: install,
    ...(options.onReport ? { onReport: options.onReport } : {})
  });
  // Installed even with no extensions, so hooks added later have a home.
  await install(host.snapshot());
  const failures: (ExtensionAlreadyInstalled | ExtensionSetupFailed)[] = [];
  for (const extension of options.extensions) {
    const added = await host.add(extension);
    if (added._tag === "err") failures.push(added.error);
  }
  return { host, failures };
}

/** Resolve skill sources only when their fingerprints change. */
function skillCache() {
  let cached:
    | {
        readonly fingerprint: string;
        readonly value: Awaited<ReturnType<typeof resolveSkillSources>>;
      }
    | undefined;
  return async (snapshot: ExtensionSnapshot) => {
    const fingerprint = skillsFingerprint(snapshot.skills);
    if (cached?.fingerprint !== fingerprint) {
      const value = await resolveSkillSources(snapshot.skills);
      for (const warning of value.warnings)
        console.warn(`pi skills: ${warning}`);
      cached = { fingerprint, value };
    }
    return cached.value;
  };
}

/** A portable tool as a pi tool registration. */
function toPiTool(tool: Tool): ToolRegistration {
  const schema = tool.input["~standard"];
  return {
    name: tool.id,
    description: tool.description,
    // pi validates arguments against this before the hooks and again after
    // them; the tool's own schema parses them once more in execute.
    parameters: Type.Unsafe<JsonObject>(
      schema.jsonSchema.input({ target: "draft-07" })
    ),
    replay: tool.replay ?? "unsafe",
    async execute(args, api, context) {
      const parsed = await schema.validate(args);
      if (parsed.issues) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid input: ${formatIssues(parsed.issues)}`
            }
          ],
          isError: true
        };
      }
      const result = await tool.execute(parsed.value, {
        session: String(api.conversationId),
        callId: api.callId,
        signal: context.abortSignal ?? new AbortController().signal,
        progress: (text) => api.output(text)
      });
      return {
        content: toPiContent(result.content),
        isError: result.isError ?? false
      };
    }
  };
}

/** A copy of a call's arguments, for hooks to edit freely. */
function portableInput(args: ToolCall["arguments"]): JsonObject {
  // SAFETY: pi-ai's JsonObject differs from the portable one only in that
  // its arrays are readonly. structuredClone makes a fresh, unshared copy,
  // so handing it out as mutable cannot reach pi's own record.
  return structuredClone(args) as JsonObject;
}

function toPiContent(
  content: ToolResult["content"]
): ToolResultMessage["content"] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part): TextContent | ImageContent =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image", data: part.data, mimeType: part.mimeType }
  );
}

function fromPiResult(result: ToolExecutionResult): ToolResult {
  const content = (result.content ?? []).map(
    (part): ToolContentPart =>
      part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "image", data: part.data, mimeType: part.mimeType }
  );
  return { content, isError: result.isError ?? false };
}
