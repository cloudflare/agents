/**
 * DEMO MODULE — ToolMiddleware.
 *
 * The tollbooth: x402-shaped payment gating in ~30 lines, riding the same
 * rail as human approval. Priced tools get their descriptors rewritten to
 * approval mode "always" with a 402 descriptor; the turn parks when the
 * model calls one, and the "payment" arrives as the verdict entry. A real
 * x402 integration keeps this exact shape and swaps the human verdict for a
 * verified payment-proof entry.
 *
 * This is also the ADR 0004 pattern live: conditional gating is middleware
 * rewriting descriptors between always and never — not a descriptor mode.
 */

import type { ToolMiddleware } from "../../contract";

export function tollbooth(prices: Readonly<Record<string, number>>): ToolMiddleware {
  return (next) => ({
    name: `tollbooth(${next.name})`,
    ...(next.resources !== undefined ? { resources: next.resources } : {}),
    async catalog() {
      const catalog = await next.catalog();
      return catalog.map((descriptor) => {
        const price = prices[descriptor.name];
        if (price === undefined) return descriptor;
        return {
          ...descriptor,
          approval: {
            mode: "always" as const,
            describe: (input: unknown) => ({
              title: `402 Payment Required — ${descriptor.name} costs ${price} credit${price === 1 ? "" : "s"}`,
              detail: "Approving this request stands in for settling the charge.",
              input: input as never
            })
          }
        };
      });
    },
    execute: (call, deps) => next.execute(call, deps)
  });
}
