# Anti-slop Oxlint plugin

This directory vendors the reusable Oxlint rules from
[dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) at commit
`6d538555cb151d4121ed51a27db81890eacf8ae9`.

The root `.oxlintrc.json` registers both plugin entry points. The generic rules
that fit the current codebase run as errors. Rules that require a broader
migration are listed as `off`, rather than omitted, so adoption decisions stay
visible.

## Initial adoption decisions

The initial audit ran against `cloudflare/agents` commit `ded09c6f`.

| Rule | Initial findings | Decision |
| --- | ---: | --- |
| `no-module-mocking` | 8 | Enabled, with file-level exceptions for existing suites that require dependency-seam refactors. |
| `no-object-parameters` | 14 | Enabled after tightening simple cases, with file-level exceptions for private instrumentation bridges and dynamic provider objects. |
| `no-reflect-apply` | 8 | Enabled, with exceptions for proxy forwarding and prototype-call tests that must preserve the receiver. |
| `no-reflect-get` | 4 | Enabled, with exceptions for proxy traps that must preserve receiver semantics. |
| `no-unknown-type-aliases` | 0 | Enabled. |
| `no-widen-then-assert` | 3 | Enabled after removing one broad schema dictionary, with an exception for the generic Agent state sentinel. |
| `no-chained-type-assertions` | 1,146 | Disabled pending package-by-package interop and test migrations. |
| `no-conditional-empty-object-spread` | 222 | Disabled because conditional option construction is an established repository pattern. |
| `no-known-value-widening` | 359 | Disabled because the rule also flags intentional public and third-party contracts. |
| `no-runtime-typeof` | 1,239 | Disabled because runtime narrowing is common at schema-free JavaScript boundaries. |
| `no-shape-in-symbol-names` | 166 | Disabled because existing public and protocol names use `shape`; renaming them may be breaking. |
| `no-unknown-parameters` | 833 | Disabled because adapters intentionally accept `unknown` at external boundaries. |
| `no-unknown-returns` | 320 | Disabled because several third-party compatibility layers intentionally return `unknown`. |
| `no-unsafe-dictionary-type` | 1,666 | Disabled because JSON, metadata, and protocol boundaries use `Record<string, unknown>`. |
| `require-safety-comment-for-type-assertion` | 7,217 | Disabled pending package-by-package assertion removal; mass comments would not add evidence. |

The Effect plugin is enabled because `site/agents` directly depends on Effect.
Its initial audit had no findings. Package-alias imports remain outside the
Effect rule's current coverage.

Oxlint 1.80 also enabled five React correctness rules that were not active in
the previous 1.71 setup. They remain explicitly disabled in `.oxlintrc.json` so
this tooling change does not silently include a separate React migration.
