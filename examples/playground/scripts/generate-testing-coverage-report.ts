import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  implementedScenarioIds,
  implementedScenariosBySpec
} from "../e2e/manual/coverage";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const playgroundDir = resolve(scriptDir, "..");
const manifestPath = join(playgroundDir, "e2e", "testing.manifest.json");
const coverageJsonPath = join(playgroundDir, "e2e", "testing.coverage.json");
const coverageMdPath = join(playgroundDir, "e2e", "testing.coverage.md");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Array<{
  id: string;
  category: string;
  section: string;
  title: string;
  route: string | null;
  flags: string[];
}>;

const implementedSet = new Set<string>(implementedScenarioIds);
const duplicateIds = implementedScenarioIds.filter(
  (id, index) => implementedScenarioIds.indexOf(id) !== index
);
const missingIds = implementedScenarioIds.filter(
  (id) => !manifest.some((scenario) => scenario.id === id)
);

if (duplicateIds.length > 0) {
  throw new Error(
    `Duplicate implemented scenario ids: ${duplicateIds.join(", ")}`
  );
}

if (missingIds.length > 0) {
  throw new Error(
    `Implemented scenario ids not found in manifest: ${missingIds.join(", ")}`
  );
}

const byCategory = new Map<
  string,
  {
    total: number;
    implemented: number;
    sections: Map<string, { total: number; implemented: number }>;
  }
>();

for (const scenario of manifest) {
  const category = byCategory.get(scenario.category) ?? {
    total: 0,
    implemented: 0,
    sections: new Map()
  };
  category.total += 1;
  if (implementedSet.has(scenario.id)) category.implemented += 1;

  const section = category.sections.get(scenario.section) ?? {
    total: 0,
    implemented: 0
  };
  section.total += 1;
  if (implementedSet.has(scenario.id)) section.implemented += 1;
  category.sections.set(scenario.section, section);
  byCategory.set(scenario.category, category);
}

const uncovered = manifest.filter(
  (scenario) => !implementedSet.has(scenario.id)
);
const payload = {
  summary: {
    total: manifest.length,
    implemented: implementedSet.size,
    uncovered: uncovered.length,
    coveragePercent:
      manifest.length === 0
        ? 0
        : Number(((implementedSet.size / manifest.length) * 100).toFixed(1))
  },
  bySpec: implementedScenariosBySpec,
  byCategory: [...byCategory.entries()].map(([category, value]) => ({
    category,
    total: value.total,
    implemented: value.implemented,
    coveragePercent: Number(
      ((value.implemented / value.total) * 100).toFixed(1)
    ),
    sections: [...value.sections.entries()].map(([section, sectionValue]) => ({
      section,
      total: sectionValue.total,
      implemented: sectionValue.implemented,
      coveragePercent: Number(
        ((sectionValue.implemented / sectionValue.total) * 100).toFixed(1)
      )
    }))
  })),
  uncovered: uncovered.map((scenario) => ({
    id: scenario.id,
    category: scenario.category,
    section: scenario.section,
    title: scenario.title,
    route: scenario.route,
    flags: scenario.flags
  }))
};

const markdown = [
  "# Playground E2E Coverage",
  "",
  `- Total scenarios from testing.md: **${payload.summary.total}**`,
  `- Implemented in manual Playwright specs: **${payload.summary.implemented}**`,
  `- Remaining generated fixme scenarios: **${payload.summary.uncovered}**`,
  `- Coverage: **${payload.summary.coveragePercent}%**`,
  "",
  "## By spec",
  "",
  ...Object.entries(implementedScenariosBySpec).map(
    ([spec, ids]) => `- \`${spec}\` — ${ids.length} scenarios`
  ),
  "",
  "## By category",
  "",
  ...payload.byCategory.flatMap((category) => [
    `### ${category.category} — ${category.implemented}/${category.total} (${category.coveragePercent}%)`,
    "",
    ...category.sections.map(
      (section) =>
        `- ${section.section}: ${section.implemented}/${section.total} (${section.coveragePercent}%)`
    ),
    ""
  ]),
  "## Remaining uncovered scenarios",
  "",
  ...payload.uncovered.map((scenario) => {
    const suffix = scenario.route ? ` — \`${scenario.route}\`` : "";
    const flags =
      scenario.flags.length > 0 ? ` [${scenario.flags.join(", ")}]` : "";
    return `- \`${scenario.id}\` — ${scenario.section} / ${scenario.title}${suffix}${flags}`;
  }),
  ""
].join("\n");

writeFileSync(coverageJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
writeFileSync(coverageMdPath, markdown);

console.log(
  `Coverage report: ${payload.summary.implemented}/${payload.summary.total} scenarios implemented`
);
