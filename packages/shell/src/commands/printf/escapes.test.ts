import { describe, expect, it } from "vitest";
import { applyWidth, parseWidthPrecision, processEscapes } from "./escapes";

describe("processEscapes", () => {
  describe("basic escapes", () => {
    it("should handle \\n (newline)", () => {
      expect(processEscapes("a\\nb")).toBe("a\nb");
    });

    it("should handle \\t (tab)", () => {
      expect(processEscapes("a\\tb")).toBe("a\tb");
    });

    it("should handle \\r (carriage return)", () => {
      expect(processEscapes("a\\rb")).toBe("a\rb");
    });

    it("should handle \\\\ (backslash)", () => {
      expect(processEscapes("a\\\\b")).toBe("a\\b");
    });

    it("should handle \\a (bell)", () => {
      expect(processEscapes("\\a")).toBe("\x07");
    });

    it("should handle \\b (backspace)", () => {
      expect(processEscapes("\\b")).toBe("\b");
    });

    it("should handle \\f (form feed)", () => {
      expect(processEscapes("\\f")).toBe("\f");
    });

    it("should handle \\v (vertical tab)", () => {
      expect(processEscapes("\\v")).toBe("\v");
    });
  });

  describe("escape character (\\e/\\E)", () => {
    it("should handle \\e for ANSI escape", () => {
      expect(processEscapes("\\e[31m")).toBe("\x1b[31m");
    });

    it("should handle \\E as alias for \\e", () => {
      expect(processEscapes("\\E[0m")).toBe("\x1b[0m");
    });

    it("should handle full ANSI color sequence", () => {
      expect(processEscapes("\\e[32mgreen\\e[0m")).toBe("\x1b[32mgreen\x1b[0m");
    });
  });

  describe("octal escapes", () => {
    it("should handle \\0 (null)", () => {
      expect(processEscapes("a\\0b")).toBe("a\0b");
    });

    it("should handle \\NNN octal sequences", () => {
      expect(processEscapes("\\101\\102\\103")).toBe("ABC");
    });

    it("should handle \\0NNN - reads max 3 octal digits", () => {
      // \0101 reads as \010 (octal 8 = backspace) followed by literal "1"
      expect(processEscapes("\\0101")).toBe("\b1");
      // \077 reads as octal 63 = "?"
      expect(processEscapes("\\077")).toBe("?");
    });
  });

  describe("hex escapes (\\x)", () => {
    it("should handle \\xHH hex sequences", () => {
      expect(processEscapes("\\x41\\x42\\x43")).toBe("ABC");
    });

    it("should handle lowercase hex", () => {
      expect(processEscapes("\\x61\\x62\\x63")).toBe("abc");
    });

    it("should handle mixed case hex", () => {
      expect(processEscapes("\\xAa")).toBe("\xaa");
    });
  });

  describe("unicode escapes (\\u)", () => {
    it("should handle \\uHHHH 4-digit unicode", () => {
      expect(processEscapes("\\u2764")).toBe("❤");
    });

    it("should handle \\u with fewer digits", () => {
      expect(processEscapes("\\u41")).toBe("A");
    });

    it("should handle checkmark unicode", () => {
      expect(processEscapes("\\u2714")).toBe("✔");
    });

    it("should handle \\u without valid hex as literal", () => {
      expect(processEscapes("\\uXYZ")).toBe("\\uXYZ");
    });
  });

  describe("unicode escapes (\\U)", () => {
    it("should handle \\UHHHHHHHH 8-digit unicode for emoji", () => {
      expect(processEscapes("\\U0001F600")).toBe("😀");
    });

    it("should handle \\U with fewer digits", () => {
      expect(processEscapes("\\U1F4C4")).toBe("📄");
    });

    it("should handle rocket emoji", () => {
      expect(processEscapes("\\U1F680")).toBe("🚀");
    });

    it("should handle \\U without valid hex as literal", () => {
      expect(processEscapes("\\UXYZ")).toBe("\\UXYZ");
    });
  });

  describe("combined escapes", () => {
    it("should handle multiple escape types together", () => {
      expect(processEscapes("\\e[31m\\u2764\\e[0m\\n")).toBe(
        "\x1b[31m❤\x1b[0m\n"
      );
    });

    it("should handle complex ANSI with unicode", () => {
      expect(processEscapes("\\U1F4C1 folder\\t\\U1F4C4 file")).toBe(
        "📁 folder\t📄 file"
      );
    });
  });
});

describe("applyWidth", () => {
  it("should right-justify with positive width", () => {
    expect(applyWidth("hi", 10, -1)).toBe("        hi");
  });

  it("should left-justify with negative width", () => {
    expect(applyWidth("hi", -10, -1)).toBe("hi        ");
  });

  it("should truncate with precision", () => {
    expect(applyWidth("hello", 0, 3)).toBe("hel");
  });

  it("should combine width and precision", () => {
    expect(applyWidth("hello", -10, 3)).toBe("hel       ");
  });

  it("should not pad if value is longer than width", () => {
    expect(applyWidth("hello", 3, -1)).toBe("hello");
  });
});

describe("parseWidthPrecision", () => {
  it("should parse simple width", () => {
    const [width, precision, consumed] = parseWidthPrecision("10f", 0);
    expect(width).toBe(10);
    expect(precision).toBe(-1);
    expect(consumed).toBe(2);
  });

  it("should parse negative width (left-justify)", () => {
    const [width, precision, consumed] = parseWidthPrecision("-20s", 0);
    expect(width).toBe(-20);
    expect(precision).toBe(-1);
    expect(consumed).toBe(3);
  });

  it("should parse precision only", () => {
    const [width, precision, consumed] = parseWidthPrecision(".5f", 0);
    expect(width).toBe(0);
    expect(precision).toBe(5);
    expect(consumed).toBe(2);
  });

  it("should parse width and precision", () => {
    const [width, precision, consumed] = parseWidthPrecision("-10.5s", 0);
    expect(width).toBe(-10);
    expect(precision).toBe(5);
    expect(consumed).toBe(5);
  });

  it("should handle no width/precision", () => {
    const [width, precision, consumed] = parseWidthPrecision("f", 0);
    expect(width).toBe(0);
    expect(precision).toBe(-1);
    expect(consumed).toBe(0);
  });
});
