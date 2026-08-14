/**
 * DEMO MODULE — AdmissionPolicy, the wacky one.
 *
 * The bouncer: messages without the magic word never become turns — no
 * error, no reply, the entry just stays on the log un-acted-upon. Silly on
 * purpose; the two real points are that admission is a FUNCTION (a config
 * enum could never say this) and that policies compose as decorators, the
 * same shape as tool middleware.
 */

import type { AdmissionPolicy, MessagePayload } from "../../contract.js";

export function bouncer(
  magicWord: string,
  inner: AdmissionPolicy
): AdmissionPolicy {
  return {
    triggers: inner.triggers,
    decide(input) {
      const payload = input.entry.payload as MessagePayload;
      if (payload.kind === "message" && payload.role === "user") {
        const text = payload.parts
          .map((p) => (p.type === "text" ? p.text : ""))
          .join(" ")
          .toLowerCase();
        if (!text.includes(magicWord.toLowerCase())) {
          return { action: "ignore" }; // not on the list
        }
      }
      return inner.decide(input);
    }
  };
}
