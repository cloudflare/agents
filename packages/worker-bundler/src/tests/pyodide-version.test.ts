import { describe, expect, it } from "vitest";
import { pyodideVersionFor } from "../installer-python";

describe("pyodideVersionFor", () => {
  it("follows the compatibility date", () => {
    const at = (compatibilityDate: string) =>
      pyodideVersionFor({ compatibilityDate, compatibilityFlags: [] });
    expect(at("2025-09-28")).toBe("v0.27.5");
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
  });
});
