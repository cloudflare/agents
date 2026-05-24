export interface SkillDescriptor {
  name: string;
  description: string;
  compatibility?: string;
  license?: string;
  allowedTools?: string;
  metadata?: Record<string, unknown>;
  sourceId?: string;
  version?: string;
}

export interface SkillContent extends SkillDescriptor {
  body: string;
  rawContent?: string;
  resources?: SkillResourceDescriptor[];
}

export interface SkillResourceDescriptor {
  path: string;
  kind: "reference" | "script" | "asset" | "file";
  size?: number;
  encoding?: "text" | "base64";
  mimeType?: string;
}

export interface SkillResource extends SkillResourceDescriptor {
  content: string;
}

export interface SkillScriptContext {
  skill: SkillDescriptor;
}

export interface SkillScriptRequest {
  skill: SkillContent;
  path: string;
  source: string;
  input: unknown;
  resources?: SkillResource[];
}

export interface SkillScriptRunner {
  run(request: SkillScriptRequest): Promise<unknown>;
}

export interface SkillSource {
  id: string;
  fingerprint: string;
  list(): Promise<SkillDescriptor[]>;
  load(name: string): Promise<SkillContent | null>;
  readResource?(name: string, path: string): Promise<SkillResource | null>;
  refresh?(): Promise<void>;
}

export interface SkillManifestResource extends SkillResourceDescriptor {
  content: string;
}

export interface SkillManifestEntry {
  name: string;
  description: string;
  body: string;
  rawContent?: string;
  compatibility?: string;
  license?: string;
  allowedTools?: string;
  metadata?: Record<string, unknown>;
  version?: string;
  resources?: SkillManifestResource[];
}

export interface SkillManifest {
  id: string;
  fingerprint: string;
  skills: SkillManifestEntry[];
}

export interface SkillRegistrySnapshot {
  fingerprint: string;
  catalogPrompt: string | null;
}

export function validateSkillResourcePath(path: string): string | null {
  if (
    path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return `Skill resource path must be a normalized relative path: ${path}`;
  }
  return null;
}
