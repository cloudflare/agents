---
"agents": minor
---

Migrate x402 MCP integration from legacy `x402` package to `@x402/core` and `@x402/evm` v2

**Breaking changes for x402 users:**

- Peer dependencies changed: replace `x402` with `@x402/core` and `@x402/evm`
- `PaymentRequirements` type now uses v2 fields (e.g. `amount` instead of `maxAmountRequired`)
- `X402ClientConfig.account` type changed from `viem.Account` to `ClientEvmSigner` (structurally compatible with `privateKeyToAccount()`)

**Migration guide:**

1. Update dependencies:

   ```bash
   npm uninstall x402
   npm install @x402/core @x402/evm
   ```

2. Update network identifiers — both legacy names and CAIP-2 format are accepted:

   ```typescript
   // Before
   {
     network: "base-sepolia";
   }
   // After (either works)
   {
     network: "base-sepolia";
   } // legacy name, auto-converted
   {
     network: "eip155:84532";
   } // CAIP-2 format (preferred)
   ```

3. If you access `PaymentRequirements` fields in callbacks, update to v2 field names (see `@x402/core` docs).

4. The `version` field on `X402Config` and `X402ClientConfig` is now deprecated and ignored — the protocol version is determined automatically.

**Other changes:**

- `X402ClientConfig.network` is now optional — the client auto-selects from available payment requirements
- Server-side lazy initialization: facilitator connection is deferred until the first paid tool invocation
- Payment tokens support both v2 (`PAYMENT-SIGNATURE`) and v1 (`X-PAYMENT`) HTTP headers
- Added `normalizeNetwork` export for converting legacy network names to CAIP-2 format
- Re-exports `PaymentRequirements`, `PaymentRequired`, `Network`, `FacilitatorConfig`, and `ClientEvmSigner` from `agents/x402`
