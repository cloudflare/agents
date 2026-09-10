import type { ResourceDiagnostic } from "../../../vendor/pi-coding-agent-src/core/diagnostics.ts";
import type { LoadExtensionsResult } from "../../../vendor/pi-coding-agent-src/core/extensions/types.ts";
import type { PathMetadata } from "../../../vendor/pi-coding-agent-src/core/package-manager.ts";
import type { PromptTemplate } from "../../../vendor/pi-coding-agent-src/core/prompt-templates.ts";
import type { Skill } from "../../../vendor/pi-coding-agent-src/core/skills.ts";
import { createSyntheticSourceInfo } from "../../../vendor/pi-coding-agent-src/core/source-info.ts";
import type { Theme } from "../../../vendor/pi-coding-agent-src/modes/interactive/theme/theme.ts";
import type { PiPromptTemplate, PiSkill } from "../types";

/**
 * Extra resource locations an extension asked pi to load.
 *
 * Declared here rather than vendored: upstream's `core/resource-loader.ts`
 * (earendil-works/pi @ c4b0e35a, lines 30-52) is a filesystem loader — Node's
 * `fs`, `path`, package installs — and none of that runs on workerd. Only the
 * two interfaces its consumers depend on are reproduced.
 */
export type ResourceExtensionPaths = {
  readonly skillPaths?: ReadonlyArray<{ path: string; metadata: PathMetadata }>;
  readonly promptPaths?: ReadonlyArray<{
    path: string;
    metadata: PathMetadata;
  }>;
  readonly themePaths?: ReadonlyArray<{ path: string; metadata: PathMetadata }>;
};

/** Options upstream's reload accepts; nothing here reloads. */
export type ResourceLoaderReloadOptions = {
  readonly resolveProjectTrust?: (input: {
    extensionsResult: LoadExtensionsResult;
  }) => Promise<boolean>;
};

/** Pi's resource surface: extensions, skills, prompts, themes, context. */
export interface ResourceLoader {
  getExtensions(): LoadExtensionsResult;
  getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
  getPrompts(): {
    prompts: PromptTemplate[];
    diagnostics: ResourceDiagnostic[];
  };
  getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
  getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
  getSystemPrompt(): string | undefined;
  getSystemPromptSource(): { path: string } | undefined;
  getAppendSystemPrompt(): string[];
  getAppendSystemPromptSources(): Array<{ path: string }>;
  extendResources(paths: ResourceExtensionPaths): void;
  reload(options?: ResourceLoaderReloadOptions): Promise<void>;
}

/** What the in-memory loader serves. */
export type PiResourceLoaderSources = {
  readonly extensions: LoadExtensionsResult;
  readonly skills: readonly PiSkill[];
  readonly promptTemplates: readonly PiPromptTemplate[];
  /** The harness's own system prompt, when the configuration fixed one. */
  readonly systemPrompt?: string;
  readonly cwd: string;
};

function toCoreSkill(skill: PiSkill, cwd: string): Skill {
  return {
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: cwd,
    sourceInfo: createSyntheticSourceInfo(skill.filePath, {
      source: "harness"
    }),
    disableModelInvocation: skill.disableModelInvocation ?? false
  };
}

function toCorePrompt(template: PiPromptTemplate): PromptTemplate {
  const filePath = `<template:${template.name}>`;
  return {
    name: template.name,
    description: template.description ?? "",
    content: template.content,
    filePath,
    sourceInfo: createSyntheticSourceInfo(filePath, { source: "harness" })
  };
}

/**
 * The harness's `ResourceLoader`: everything already in memory, nothing on
 * disk.
 *
 * A Durable Object has no filesystem, so resources arrive through the
 * configuration instead of being discovered: extensions from the loaded
 * result, skills from the harness's resolved skill sources, prompt templates
 * from `promptTemplates`, and the system prompt from the configuration when it
 * is a fixed string. Themes and `AGENTS.md` files have no counterpart and stay
 * empty.
 *
 * `extendResources` is the one place an extension can still ask for more:
 * paths it discovers cannot be read, so each is recorded as a warning
 * diagnostic that surfaces beside the resources that did load. `reload` is a
 * no-op — every wake rebuilds the runtime from configuration, which is what a
 * reload would have done.
 */
export function createResourceLoader(
  sources: PiResourceLoaderSources
): ResourceLoader {
  const skills = sources.skills.map((skill) => toCoreSkill(skill, sources.cwd));
  const prompts = sources.promptTemplates.map(toCorePrompt);
  const skillDiagnostics: ResourceDiagnostic[] = [];
  const promptDiagnostics: ResourceDiagnostic[] = [];
  const themeDiagnostics: ResourceDiagnostic[] = [];

  const warn = (
    into: ResourceDiagnostic[],
    kind: string,
    entry: { path: string; metadata: PathMetadata }
  ): void => {
    into.push({
      type: "warning",
      message: `Cannot load ${kind} from ${entry.path}: this harness has no filesystem. Supply it through the harness configuration instead.`,
      path: entry.path
    });
  };

  return {
    getExtensions: () => sources.extensions,
    getSkills: () => ({
      skills: [...skills],
      diagnostics: [...skillDiagnostics]
    }),
    getPrompts: () => ({
      prompts: [...prompts],
      diagnostics: [...promptDiagnostics]
    }),
    getThemes: () => ({ themes: [], diagnostics: [...themeDiagnostics] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => sources.systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: (paths) => {
      for (const entry of paths.skillPaths ?? [])
        warn(skillDiagnostics, "skills", entry);
      for (const entry of paths.promptPaths ?? [])
        warn(promptDiagnostics, "prompt templates", entry);
      for (const entry of paths.themePaths ?? [])
        warn(themeDiagnostics, "themes", entry);
    },
    reload: async () => {}
  };
}

/** Metadata attributed to a path one extension discovered. */
export function extensionPathMetadata(extensionPath: string): PathMetadata {
  return { source: extensionPath, scope: "temporary", origin: "top-level" };
}
