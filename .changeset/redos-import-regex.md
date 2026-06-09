---
"@cloudflare/worker-bundler": patch
---

fix: eliminate polynomial-time ReDoS in import/export matching. The `importExportRegex` in `rewriteImports` and the regex fallback in `parseImports` matched the import clause with `[\w*{}\s,]+` followed by `\s+`, letting both quantifiers consume the same whitespace and backtrack catastrophically on near-match inputs (`import` + 10k spaces took ~175s). Clauses are now matched as non-whitespace tokens separated by whitespace, which is linear and behaviorally equivalent.
