import { parseCommandArgs } from "../../../vendor/pi-coding-agent-src/core/prompt-templates.ts";
import type { SlashCommandInfo } from "../../../vendor/pi-coding-agent-src/core/slash-commands.ts";
import { createSyntheticSourceInfo } from "../../../vendor/pi-coding-agent-src/core/source-info.ts";
import type {
  PiOperationRequest,
  PiPromptTemplate,
  PiSkill,
  PiSlashCommand
} from "../types";

/** A submitted prompt that started with `/name`. */
export type ParsedSlashCommand = {
  readonly name: string;
  /** Everything after the command name, unparsed and untrimmed. */
  readonly args: string;
};

/**
 * Split `/name args` into its parts. Returns nothing when the text is not a
 * slash invocation, which includes a bare `/` and a leading `//` escape.
 */
export function parseSlashCommand(
  text: string
): ParsedSlashCommand | undefined {
  const match = /^\/([^\s/]\S*)(?:\s+([\s\S]*))?$/.exec(text.trimStart());
  if (!match) return undefined;
  return { name: match[1] as string, args: match[2] ?? "" };
}

/** The command surfaces one lane can dispatch a slash invocation to. */
export type SlashCommandSources = {
  /** Commands the loaded extensions registered, in pi's own shape. */
  readonly extension: readonly SlashCommandInfo[];
  readonly promptTemplates: readonly PiPromptTemplate[];
  /** Skills invocable by name, from the harness's resolved resources. */
  readonly skills: readonly PiSkill[];
};

/**
 * Every slash command this harness offers, in pi's `SlashCommandInfo` shape.
 *
 * Pi's own built-ins (`BUILTIN_SLASH_COMMANDS`) are deliberately absent: they
 * are terminal-mode features — settings menus, session switching, quitting —
 * and a Durable Object implements none of them.
 *
 * The first registration of a name wins, in pi's resolution order: extension
 * commands, then prompt templates, then skills.
 */
export function slashCommandInfos(
  sources: SlashCommandSources
): SlashCommandInfo[] {
  const infos: SlashCommandInfo[] = [];
  const seen = new Set<string>();
  const add = (info: SlashCommandInfo): void => {
    if (seen.has(info.name)) return;
    seen.add(info.name);
    infos.push(info);
  };
  for (const command of sources.extension) add(command);
  for (const template of sources.promptTemplates) {
    add({
      name: template.name,
      ...(template.description === undefined
        ? {}
        : { description: template.description }),
      source: "prompt",
      sourceInfo: createSyntheticSourceInfo(`<template:${template.name}>`, {
        source: "harness"
      })
    });
  }
  for (const skill of sources.skills) {
    add({
      name: skill.name,
      description: skill.description,
      source: "skill",
      sourceInfo: createSyntheticSourceInfo(`<skill:${skill.name}>`, {
        source: "harness"
      })
    });
  }
  return infos;
}

/** Project pi's command list onto the wire shape clients autocomplete from. */
export function piSlashCommands(
  infos: readonly SlashCommandInfo[]
): PiSlashCommand[] {
  return infos.map((info) => ({
    name: info.name,
    description: info.description ?? "",
    source: info.source === "prompt" ? "template" : info.source
  }));
}

/** What the resolver needs to know about a lane's command surfaces. */
export type SubmissionResolverDeps = {
  /** Whether an extension registered a command under this name. */
  readonly hasCommand: (name: string) => boolean;
  readonly promptTemplates: readonly PiPromptTemplate[];
  readonly skills: readonly PiSkill[];
};

/** How one submitted prompt should be handled. */
export type ResolvedSubmission =
  | {
      /** An extension command: run its handler, queue nothing. */
      readonly kind: "command";
      readonly name: string;
      readonly args: string;
    }
  | { readonly kind: "request"; readonly request: PiOperationRequest };

/**
 * Route one submission, after pi's `input` event has had it.
 *
 * A prompt beginning with `/name` is resolved against the same three sources
 * `getCommands` lists, in the same order: an extension command runs out of
 * band, a prompt template becomes a durable `prompt_template` operation, and a
 * skill becomes a durable `skill` operation. Anything else stays the prompt
 * the caller submitted, `/` included: an unknown slash command is text, which
 * is what pi does with one too.
 */
export function resolveSubmission(
  request: PiOperationRequest,
  deps: SubmissionResolverDeps
): ResolvedSubmission {
  if (request.kind !== "prompt") return { kind: "request", request };
  const parsed = parseSlashCommand(request.prompt);
  if (!parsed) return { kind: "request", request };

  if (deps.hasCommand(parsed.name)) {
    return { kind: "command", name: parsed.name, args: parsed.args };
  }

  const operationId =
    request.operationId === undefined
      ? {}
      : { operationId: request.operationId };

  const template = deps.promptTemplates.find(
    (candidate) => candidate.name === parsed.name
  );
  if (template) {
    // Pi expands the template itself, against the resources the harness
    // supplied; only the positional arguments are parsed here.
    return {
      kind: "request",
      request: {
        kind: "prompt_template",
        ...operationId,
        name: template.name,
        args: parseCommandArgs(parsed.args)
      }
    };
  }

  const skill = deps.skills.find((candidate) => candidate.name === parsed.name);
  if (skill) {
    const additional = parsed.args.trim();
    return {
      kind: "request",
      request: {
        kind: "skill",
        ...operationId,
        name: skill.name,
        ...(additional === "" ? {} : { additionalInstructions: additional })
      }
    };
  }

  return { kind: "request", request };
}
