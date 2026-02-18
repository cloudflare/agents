import { describe, expect, it } from "vitest";
import { camelCaseToKebabCase } from "../utils";

describe("camelCaseToKebabCase", () => {
  describe("basic camelCase and PascalCase", () => {
    it("should convert simple PascalCase", () => {
      expect(camelCaseToKebabCase("TestStateAgent")).toBe("test-state-agent");
    });

    it("should convert simple camelCase", () => {
      expect(camelCaseToKebabCase("testStateAgent")).toBe("test-state-agent");
    });

    it("should convert single word PascalCase", () => {
      expect(camelCaseToKebabCase("Agent")).toBe("agent");
    });

    it("should handle single lowercase word", () => {
      expect(camelCaseToKebabCase("agent")).toBe("agent");
    });
  });

  describe("acronyms (consecutive uppercase letters)", () => {
    it("should treat leading acronym as a single unit", () => {
      expect(camelCaseToKebabCase("AISessionAgent")).toBe("ai-session-agent");
    });

    it("should treat leading acronym followed by lowercase", () => {
      expect(camelCaseToKebabCase("APIEndpoint")).toBe("api-endpoint");
    });

    it("should handle acronym in the middle", () => {
      expect(camelCaseToKebabCase("MyUIComponent")).toBe("my-ui-component");
    });

    it("should handle acronym at the end", () => {
      expect(camelCaseToKebabCase("ComponentUI")).toBe("component-ui");
    });

    it("should handle adjacent acronyms followed by lowercase", () => {
      // Adjacent all-caps acronyms without lowercase separators are ambiguous;
      // the regex treats the whole run as one acronym until the final
      // uppercase-before-lowercase boundary.
      expect(camelCaseToKebabCase("XMLHTTPRequest")).toBe("xmlhttp-request");
    });

    it("should handle separated acronyms (e.g. XmlHttpRequest)", () => {
      expect(camelCaseToKebabCase("XmlHttpRequest")).toBe("xml-http-request");
    });

    it("should handle two-letter acronym at start", () => {
      expect(camelCaseToKebabCase("DBConnection")).toBe("db-connection");
    });
  });

  describe("all uppercase strings", () => {
    it("should convert all uppercase to lowercase", () => {
      expect(camelCaseToKebabCase("ALLCAPS")).toBe("allcaps");
    });

    it("should convert underscored uppercase to kebab-case", () => {
      expect(camelCaseToKebabCase("MY_AGENT")).toBe("my-agent");
    });
  });

  describe("already kebab-case", () => {
    it("should pass through kebab-case unchanged", () => {
      expect(camelCaseToKebabCase("already-kebab-case")).toBe(
        "already-kebab-case"
      );
    });

    it("should pass through single lowercase word", () => {
      expect(camelCaseToKebabCase("simple")).toBe("simple");
    });
  });

  describe("underscores", () => {
    it("should convert underscores to hyphens", () => {
      expect(camelCaseToKebabCase("my_agent")).toBe("my-agent");
    });

    it("should convert mixed underscores and camelCase", () => {
      expect(camelCaseToKebabCase("myAgent_name")).toBe("my-agent-name");
    });
  });

  describe("edge cases", () => {
    it("should handle empty string", () => {
      expect(camelCaseToKebabCase("")).toBe("");
    });

    it("should handle single character", () => {
      expect(camelCaseToKebabCase("A")).toBe("a");
    });

    it("should handle two-letter acronym alone", () => {
      expect(camelCaseToKebabCase("AI")).toBe("ai");
    });

    it("should not produce trailing hyphens", () => {
      const result = camelCaseToKebabCase("TestAgent");
      expect(result.endsWith("-")).toBe(false);
    });

    it("should not produce leading hyphens", () => {
      const result = camelCaseToKebabCase("TestAgent");
      expect(result.startsWith("-")).toBe(false);
    });
  });
});
