import { agent } from "@cloudflare/think/framework";

// Declarative sub-agent (vs the sibling `researcher.ts` class). Discovery
// generates the class `ThinkSubAgent_Sales_Analyst` at build time via the
// definition's `__toThinkClass`, so the drill-in route must resolve it the
// same way it resolves a class-based facet.
export default agent({
  model: { id: "test-model" } as never
});
