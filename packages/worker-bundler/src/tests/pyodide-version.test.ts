import { describe, expect, it } from "vitest";
import { pyodideVersionFor } from "../installer-python";

describe("pyodideVersionFor", () => {
  it("follows the compatibility date", () => {
    const at = (compatibilityDate: string) =>
      pyodideVersionFor({ compatibilityDate, compatibilityFlags: [] });
    expect(at("2025-09-28")).toBe("v0.26.0a2");
    expect(at("2025-09-29")).toBe("v0.28.2");
    expect(at("2026-09-07")).toBe("v0.28.2");
    expect(at("2026-09-08")).toBe("v314.0.6");
  });

  it("follows the Python version flags over the date", () => {
    expect(
      pyodideVersionFor({
        compatibilityDate: "2025-01-01",
        compatibilityFlags: ["python_workers_314"]
      })
    ).toBe("v314.0.6");
    expect(
      pyodideVersionFor({
        compatibilityDate: "2025-01-01",
        compatibilityFlags: ["python_workers_20250116"]
      })
    ).toBe("v0.28.2");
    expect(
      pyodideVersionFor({
        compatibilityDate: "2025-01-01",
        compatibilityFlags: ["python_workers_20260610"]
      })
    ).toBe("v314.0.6");
  });

  it("keeps 3.14 for a 2026-09-08 date even with the 3.13 flag", () => {
    // Measured in production: a later Python's date wins over an earlier
    // version's flag.
    expect(
      pyodideVersionFor({
        compatibilityDate: "2026-11-20",
        compatibilityFlags: ["python_workers_20250116"]
      })
    ).toBe("v314.0.6");
  });

  it("follows the flags that turn a date's Python off", () => {
    const on = (compatibilityDate: string, ...compatibilityFlags: string[]) =>
      pyodideVersionFor({ compatibilityDate, compatibilityFlags });
    expect(on("2026-11-20", "no_python_workers_314")).toBe("v0.28.2");
    expect(
      on("2026-11-20", "no_python_workers_314", "no_python_workers_20250116")
    ).toBe("v0.26.0a2");
    expect(on("2026-01-01", "no_python_workers_20250116")).toBe("v0.26.0a2");
  });
});
