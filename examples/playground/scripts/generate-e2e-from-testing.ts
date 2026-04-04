import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Scenario = {
  id: string;
  category: string;
  section: string;
  route: string | null;
  testNumber: number | null;
  title: string;
  action: string[];
  expected: string[];
  notes: string[];
  flags: string[];
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const playgroundDir = resolve(scriptDir, "..");
const testingPath = join(playgroundDir, "testing.md");
const manifestPath = join(playgroundDir, "e2e", "testing.manifest.json");
const generatedSpecPath = join(
  playgroundDir,
  "e2e",
  "generated",
  "testing.generated.spec.ts"
);

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function jsonString(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function parseTestingMarkdown(markdown: string): Scenario[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const scenarios: Scenario[] = [];

  let currentCategory = "Uncategorized";
  let currentSection = "Unknown Section";
  let currentRoute: string | null = null;
  let currentNotes: string[] = [];
  let currentScenario: Scenario | null = null;
  let captureMode: "action" | "expected" | "notes" | null = null;

  const pushScenario = () => {
    if (!currentScenario) return;

    currentScenario.notes = [...currentNotes, ...currentScenario.notes].filter(
      Boolean
    );

    const joinedText = [
      currentCategory,
      currentSection,
      currentScenario.title,
      currentScenario.action.join(" "),
      currentScenario.expected.join(" "),
      currentScenario.notes.join(" ")
    ]
      .join(" ")
      .toLowerCase();

    const flags = new Set<string>();
    if (joinedText.includes("deployed only")) flags.add("deployed-only");
    if (joinedText.includes("documentation-only"))
      flags.add("documentation-only");
    if (joinedText.includes("multi-tab") || joinedText.includes("new tab")) {
      flags.add("multi-tab");
    }
    if (currentScenario.route === null) flags.add("global-ui");

    currentScenario.flags = [...flags].sort();
    scenarios.push(currentScenario);
    currentScenario = null;
    captureMode = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    const categoryMatch = trimmed.match(/^##\s+(?!#)(.+)$/);
    if (categoryMatch) {
      pushScenario();
      currentCategory = categoryMatch[1].trim();
      currentSection = "Unknown Section";
      currentRoute = null;
      currentNotes = [];
      continue;
    }

    const sectionMatch = trimmed.match(/^###\s+(.+?)(?:\s+\(`([^`]+)`\))?$/);
    if (sectionMatch) {
      pushScenario();
      currentSection = sectionMatch[1].trim();
      currentRoute = sectionMatch[2] ?? null;
      currentNotes = [];
      continue;
    }

    const testMatch = trimmed.match(/^####\s+Test\s+(\d+)\s*:\s+(.+)$/i);
    if (testMatch) {
      pushScenario();
      const testNumber = Number(testMatch[1]);
      const title = testMatch[2].trim();
      currentScenario = {
        id: slugify(
          [currentCategory, currentSection, `test-${testNumber}`, title].join(
            " "
          )
        ),
        category: currentCategory,
        section: currentSection,
        route: currentRoute,
        testNumber,
        title,
        action: [],
        expected: [],
        notes: [],
        flags: []
      };
      captureMode = null;
      continue;
    }

    if (!currentScenario) {
      if (trimmed && !trimmed.startsWith("---")) {
        currentNotes.push(trimmed);
      }
      continue;
    }

    if (!trimmed) {
      captureMode = captureMode === "notes" ? "notes" : null;
      continue;
    }

    const actionMatch = trimmed.match(/^-\s+\*\*Action\*\*:\s*(.*)$/);
    if (actionMatch) {
      captureMode = "action";
      if (actionMatch[1].trim())
        currentScenario.action.push(actionMatch[1].trim());
      continue;
    }

    const expectedMatch = trimmed.match(/^-\s+\*\*Expected\*\*:\s*(.*)$/);
    if (expectedMatch) {
      captureMode = "expected";
      if (expectedMatch[1].trim()) {
        currentScenario.expected.push(expectedMatch[1].trim());
      }
      continue;
    }

    const nestedBulletMatch = trimmed.match(/^[-*]\s+(.*)$/);
    if (nestedBulletMatch) {
      if (captureMode === "action") {
        currentScenario.action.push(nestedBulletMatch[1].trim());
      } else if (captureMode === "expected") {
        currentScenario.expected.push(nestedBulletMatch[1].trim());
      } else {
        currentScenario.notes.push(nestedBulletMatch[1].trim());
        captureMode = "notes";
      }
      continue;
    }

    const numberedMatch = trimmed.match(/^\d+\.\s+(.*)$/);
    if (numberedMatch && captureMode === "action") {
      currentScenario.action.push(numberedMatch[1].trim());
      continue;
    }

    if (captureMode === "action") {
      currentScenario.action.push(trimmed);
    } else if (captureMode === "expected") {
      currentScenario.expected.push(trimmed);
    } else {
      currentScenario.notes.push(trimmed);
      captureMode = "notes";
    }
  }

  pushScenario();
  return scenarios;
}

function generateSpec(scenarios: Scenario[]) {
  const grouped = new Map<string, Scenario[]>();

  for (const scenario of scenarios) {
    const key = `${scenario.category}|||${scenario.section}`;
    const existing = grouped.get(key) ?? [];
    existing.push(scenario);
    grouped.set(key, existing);
  }

  const blocks = [...grouped.entries()].map(([key, sectionScenarios]) => {
    const [category, section] = key.split("|||");
    const body = sectionScenarios
      .map((scenario) => {
        const titleBits = [category, section];
        if (scenario.testNumber !== null) {
          titleBits.push(`Test ${scenario.testNumber}`);
        }
        titleBits.push(scenario.title);
        const title = titleBits.join(" / ");
        const detailLines = [
          scenario.route
            ? `Route: ${scenario.route}`
            : "Route: n/a (global UI)",
          scenario.action.length > 0
            ? `Action:\n${scenario.action.map((item) => `- ${item}`).join("\n")}`
            : "Action: n/a",
          scenario.expected.length > 0
            ? `Expected:\n${scenario.expected
                .map((item) => `- ${item}`)
                .join("\n")}`
            : "Expected: n/a",
          scenario.flags.length > 0
            ? `Flags: ${scenario.flags.join(", ")}`
            : "Flags: none"
        ].join("\n\n");

        return `  test.fixme(${jsonString(title)}, async ({ page }) => {
    ${scenario.route ? `await page.goto(${jsonString(scenario.route)});` : "await page.goto('/');"}
    test.info().annotations.push({
      type: "generated-from-testing-md",
      description: ${jsonString(detailLines)}
    });
  });`;
      })
      .join("\n\n");

    return `test.describe(${jsonString(`${category} / ${section}`)}, () => {
${body}
});`;
  });

  return `import { test } from "@playwright/test";

// Generated by scripts/generate-e2e-from-testing.ts from testing.md.
// Do not edit this file by hand.

${blocks.join("\n\n")}
`;
}

const markdown = readFileSync(testingPath, "utf8");
const scenarios = parseTestingMarkdown(markdown);

mkdirSync(dirname(manifestPath), { recursive: true });
mkdirSync(dirname(generatedSpecPath), { recursive: true });

writeFileSync(manifestPath, `${jsonString(scenarios)}\n`);
writeFileSync(generatedSpecPath, generateSpec(scenarios));

console.log(
  `Generated ${scenarios.length} scenarios from ${testingPath.replace(`${playgroundDir}/`, "")}`
);
