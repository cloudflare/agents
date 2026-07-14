# Skills

On-demand instruction documents surfaced to the model as a catalog, rather than
baked always-on into the system prompt. The model activates a skill when it needs
it. See the [context map](../../../CONTEXT-MAP.md).

## Language

**Skill**:
An on-demand instruction document (name, description, markdown instructions,
resources) the model can activate for the current conversation.
_Avoid_: prompt, plugin, capability

**SkillDefinition**:
The skill model: name (the unique directory name), description, instructions, and
resources.

**SkillResource**:
A file bundled with a skill (content + encoding + media type), referenced by a
relative path.

**SkillSource**:
A provider of skills (`id` + `list()`) — e.g. a static manifest or a workspace
directory. First source to register a name wins.
_Avoid_: skill provider, skill loader

**SkillRegistry**:
The composed collection of skills across sources, producing the catalog block and
the skill tool set.

**SKILL.md**:
The per-skill markdown file whose frontmatter yields the description and whose body
is the instructions.

**Frontmatter**:
The `---`-delimited minimal-YAML block (top-level string keys only) at the top of a
SKILL.md.

**Catalog block**:
The deterministic `name — description` list appended to the system prompt when at
least one skill exists, explaining how to activate one.
_Avoid_: skills list, index

**activate_skill**:
The tool that returns a skill's full instructions ("the model now has this skill
for the conversation").

**read_skill_resource**:
The tool that returns a bundled resource, by `{ name, path }` or a qualified
`skill/relative/path` (cross-skill reference).
