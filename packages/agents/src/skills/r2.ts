import { parseSkillMarkdown } from "./frontmatter";
import type {
  SkillContent,
  SkillDescriptor,
  SkillResource,
  SkillResourceDescriptor,
  SkillSource
} from "./types";
import { validateSkillResourcePath } from "./types";

export interface R2SkillSourceOptions {
  prefix?: string;
  skills?: string[];
  id?: string;
  fingerprint?: "metadata" | "content";
  refreshIntervalMs?: number;
}

type ListedObject = Pick<R2Object, "key" | "etag" | "size" | "uploaded">;

interface IndexedSkill {
  descriptor: SkillDescriptor;
  content: SkillContent;
  directory: string;
}

function normalizePrefix(prefix: string | undefined): string {
  if (!prefix) return "";
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

function resourceKind(path: string): SkillResourceDescriptor["kind"] {
  if (path.startsWith("references/")) return "reference";
  if (path.startsWith("scripts/")) return "script";
  if (path.startsWith("assets/")) return "asset";
  return "file";
}

const TEXT_EXTENSIONS = new Set([
  ".bash",
  ".css",
  ".csv",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".py",
  ".sh",
  ".svg",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
]);

const MIME_TYPES = new Map([
  [".css", "text/css"],
  [".gif", "image/gif"],
  [".html", "text/html"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".js", "text/javascript"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".mjs", "text/javascript"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".py", "text/x-python"],
  [".sh", "text/x-shellscript"],
  [".svg", "image/svg+xml"],
  [".ts", "text/typescript"],
  [".tsx", "text/typescript"],
  [".txt", "text/plain"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"]
]);

function extensionOf(path: string): string {
  const file = path.split("/").at(-1) ?? path;
  const index = file.lastIndexOf(".");
  return index === -1 ? "" : file.slice(index).toLowerCase();
}

function resourceEncoding(path: string): "text" | "base64" {
  return TEXT_EXTENSIONS.has(extensionOf(path)) ? "text" : "base64";
}

function resourceMimeType(path: string): string | undefined {
  return MIME_TYPES.get(extensionOf(path));
}

function base64Encode(bytes: ArrayBuffer): string {
  let binary = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i++) {
    binary += String.fromCharCode(view[i]!);
  }
  return btoa(binary);
}

async function readObjectFingerprint(
  bucket: R2Bucket,
  key: string,
  path: string
): Promise<string | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  const encoding = resourceEncoding(path);
  const content =
    encoding === "base64"
      ? base64Encode(await object.arrayBuffer())
      : await object.text();
  return `${encoding}:${content}`;
}

function stableHash(parts: string[]): string {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      hash ^= part.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    // Fold a boundary between parts so that, e.g., ["ab", "cd"] and ["abcd"]
    // hash differently (otherwise the concatenated char stream is identical).
    hash ^= 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function objectFingerprintPart(object: ListedObject): string {
  return [
    object.key,
    String(object.size),
    object.etag,
    object.uploaded?.toISOString() ?? ""
  ].join(":");
}

async function listAllObjects(
  bucket: R2Bucket,
  prefix: string
): Promise<ListedObject[]> {
  const objects: ListedObject[] = [];
  let cursor: string | undefined;
  let truncated = true;

  while (truncated) {
    const listed = await bucket.list({ prefix, cursor });
    objects.push(...listed.objects);
    truncated = listed.truncated;
    cursor = listed.truncated ? listed.cursor : undefined;
  }

  return objects.sort((a, b) => a.key.localeCompare(b.key));
}

async function readObject(
  bucket: R2Bucket,
  key: string
): Promise<string | null> {
  const object = await bucket.get(key);
  return object ? object.text() : null;
}

async function readResourceObject(
  bucket: R2Bucket,
  key: string,
  descriptor: SkillResourceDescriptor
): Promise<SkillResource | null> {
  const object = await bucket.get(key);
  if (!object) return null;

  const encoding = descriptor.encoding ?? resourceEncoding(descriptor.path);
  const content =
    encoding === "base64"
      ? base64Encode(await object.arrayBuffer())
      : await object.text();

  return {
    ...descriptor,
    encoding,
    content
  };
}

export function r2(
  bucket: R2Bucket,
  options: R2SkillSourceOptions = {}
): SkillSource {
  const prefix = normalizePrefix(options.prefix);
  const id = options.id ?? `r2:${prefix || "/"}`;
  const allowedSkills = options.skills?.length ? new Set(options.skills) : null;
  const fingerprintMode = options.fingerprint ?? "metadata";
  const refreshIntervalMs = options.refreshIntervalMs ?? 60_000;
  let fingerprint = id;
  let loaded = false;
  let indexedAt = 0;
  let byName = new Map<string, IndexedSkill>();
  let resourcesByName = new Map<string, SkillResourceDescriptor[]>();

  async function refreshIndex(force = false): Promise<void> {
    if (loaded && !force && Date.now() - indexedAt < refreshIntervalMs) {
      return;
    }

    const objects = await listAllObjects(bucket, prefix);
    const objectsByKey = new Map(objects.map((object) => [object.key, object]));
    const skillDirectories = objects
      .map((object) => object.key.slice(prefix.length))
      .filter((key) => key.endsWith("/SKILL.md"))
      .map((key) => key.slice(0, -"SKILL.md".length - 1))
      .filter((directory) => directory && !directory.includes("/"));

    const nextByName = new Map<string, IndexedSkill>();
    const nextResourcesByName = new Map<string, SkillResourceDescriptor[]>();
    const fingerprintParts: string[] = [];

    for (const directory of skillDirectories) {
      const skillKey = `${prefix}${directory}/SKILL.md`;
      const rawContent = await readObject(bucket, skillKey);
      if (!rawContent) continue;

      const parsed = parseSkillMarkdown(rawContent);
      if (!parsed || allowedSkills?.has(parsed.name) === false) continue;

      const resourceKeys = objects
        .map((object) => object.key)
        .filter(
          (key) => key.startsWith(`${prefix}${directory}/`) && key !== skillKey
        )
        .filter(
          (key) =>
            validateSkillResourcePath(
              key.slice(`${prefix}${directory}/`.length)
            ) === null
        );
      const resources: SkillResourceDescriptor[] = [];

      for (const key of resourceKeys) {
        const path = key.slice(`${prefix}${directory}/`.length);
        const listedResource = objectsByKey.get(key);

        resources.push({
          path,
          kind: resourceKind(path),
          size: listedResource?.size,
          encoding: resourceEncoding(path),
          mimeType: resourceMimeType(path)
        });
      }

      const descriptor: SkillDescriptor = {
        name: parsed.name,
        description: parsed.description,
        compatibility: parsed.compatibility,
        license: parsed.license,
        allowedTools: parsed.allowedTools,
        metadata: parsed.metadata,
        sourceId: id
      };
      const content: SkillContent = {
        ...descriptor,
        body: parsed.body,
        rawContent,
        resources: resources.map((resource) => ({ ...resource }))
      };

      if (!nextByName.has(parsed.name)) {
        nextByName.set(parsed.name, { descriptor, content, directory });
        nextResourcesByName.set(parsed.name, resources);
      }

      const skillObjects = [skillKey, ...resourceKeys]
        .map((key) => objectsByKey.get(key))
        .filter((object): object is ListedObject => Boolean(object));
      if (fingerprintMode === "content") {
        fingerprintParts.push(rawContent);
        for (const key of resourceKeys) {
          const path = key.slice(`${prefix}${directory}/`.length);
          fingerprintParts.push(
            (await readObjectFingerprint(bucket, key, path)) ?? ""
          );
        }
      } else {
        fingerprintParts.push(...skillObjects.map(objectFingerprintPart));
      }
    }

    byName = nextByName;
    resourcesByName = nextResourcesByName;
    fingerprint = `${id}:${stableHash(fingerprintParts)}`;
    loaded = true;
    indexedAt = Date.now();
  }

  return {
    id,
    get fingerprint() {
      return fingerprint;
    },
    async list() {
      await refreshIndex();
      return [...byName.values()].map(({ descriptor }) => ({ ...descriptor }));
    },
    async load(name: string) {
      await refreshIndex();
      const skill = byName.get(name);
      return skill ? { ...skill.content } : null;
    },
    async readResource(name: string, path: string) {
      if (validateSkillResourcePath(path) !== null) return null;
      await refreshIndex();
      const skill = byName.get(name);
      if (!skill) return null;

      const resource = resourcesByName
        .get(name)
        ?.find((entry) => entry.path === path);
      if (!resource) return null;

      return readResourceObject(
        bucket,
        `${prefix}${skill.directory}/${path}`,
        resource
      );
    },
    async refresh() {
      await refreshIndex();
    }
  };
}
