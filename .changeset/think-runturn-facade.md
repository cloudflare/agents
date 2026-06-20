---
"@cloudflare/think": minor
---

Add public `runTurn(options)` facade (Turns RFC step 2): unified turn admission
with `mode: "wait" | "submit" | "stream"` delegating to the existing
`saveMessages`, `continueLastTurn`, `submitMessages`, and `chat` methods.
Exports `TurnInputMessages`, `RunTurnWait`, `RunTurnSubmit`, `RunTurnStream`,
`RunTurnOptions`, and `TurnResult`.
