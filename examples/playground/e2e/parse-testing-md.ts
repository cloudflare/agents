import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type Scenario = {
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

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function parseTestingMarkdown(markdown: string): Scenario[] {
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
    const trimmed = rawLine.trim();

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

export function loadScenarios(): Scenario[] {
  const e2eDir = dirname(fileURLToPath(import.meta.url));
  const playgroundDir = resolve(e2eDir, "..");
  const testingPath = join(playgroundDir, "testing.md");
  const markdown = readFileSync(testingPath, "utf8");
  return parseTestingMarkdown(markdown);
}
