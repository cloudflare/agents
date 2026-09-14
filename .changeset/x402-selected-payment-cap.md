---
"agents": patch
---

Fix `withX402Client` enforcing `maxPaymentValue` against the first advertised payment requirement instead of the requirement selected for signing. Validate the selected amount after scheme and network selection, before signing or retrying the tool call.
