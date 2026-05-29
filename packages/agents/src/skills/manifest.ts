import type {
  SkillContent,
  SkillDescriptor,
  SkillManifest,
  SkillManifestEntry,
  SkillResource,
  SkillSource
} from "./types";
import { validateSkillResourcePath } from "./types";

function descriptorFromEntry(
  sourceId: string,
  entry: SkillManifestEntry
): SkillDescriptor {
  return {
    name: entry.name,
    description: entry.description,
    compatibility: entry.compatibility,
    license: entry.license,
    allowedTools: entry.allowedTools,
    metadata: entry.metadata,
    sourceId,
    version: entry.version
  };
}

function contentFromEntry(
  sourceId: string,
  entry: SkillManifestEntry
): SkillContent {
  return {
    ...descriptorFromEntry(sourceId, entry),
    body: entry.body,
    rawContent: entry.rawContent,
    resources: entry.resources
      ?.filter((resource) => validateSkillResourcePath(resource.path) === null)
      .map(({ content: _content, ...resource }) => ({
        ...resource
      }))
  };
}

export function fromManifest(manifest: SkillManifest): SkillSource {
  const byName = new Map(manifest.skills.map((skill) => [skill.name, skill]));

  return {
    id: manifest.id,
    fingerprint: manifest.fingerprint,
    async list() {
      return manifest.skills.map((skill) =>
        descriptorFromEntry(manifest.id, skill)
      );
    },
    async load(name: string) {
      const skill = byName.get(name);
      return skill ? contentFromEntry(manifest.id, skill) : null;
    },
    async readResource(
      name: string,
      path: string
    ): Promise<SkillResource | null> {
      const skill = byName.get(name);
      if (validateSkillResourcePath(path) !== null) return null;
      const resource = skill?.resources?.find((entry) => entry.path === path);
      if (resource && validateSkillResourcePath(resource.path) !== null) {
        return null;
      }
      return resource ? { ...resource } : null;
    }
  };
}
