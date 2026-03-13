# Imported ripgrep Tests

These tests are transliterated from [ripgrep](https://github.com/BurntSushi/ripgrep), the original Rust-based search tool.

## Source

Tests were imported from the ripgrep test suite:

- https://github.com/BurntSushi/ripgrep/tree/master/tests

## Files

| File                 | Source                | Description                         |
| -------------------- | --------------------- | ----------------------------------- |
| `binary.test.ts`     | `tests/binary.rs`     | Binary file detection and handling  |
| `feature.test.ts`    | `tests/feature.rs`    | Feature tests from GitHub issues    |
| `json.test.ts`       | `tests/json.rs`       | JSON output format                  |
| `misc.test.ts`       | `tests/misc.rs`       | Miscellaneous behavior tests + gzip |
| `multiline.test.ts`  | `tests/multiline.rs`  | Multiline matching tests            |
| `regression.test.ts` | `tests/regression.rs` | Regression tests from bug reports   |

## Skipped Tests

Some tests are skipped due to implementation differences:

### json.rs

- `notutf8`, `notutf8_file` - Non-UTF8 file handling not supported
- `crlf`, `r1095_*` - `--crlf` flag not implemented
- `r1412_*` - Requires PCRE2 look-behind

### multiline.rs

- Tests using `\p{Any}` Unicode property (not supported in JavaScript regex)
- `--multiline-dotall` flag (not implemented)

### misc.rs

- `compressed_*` for bzip2, xz, lz4, lzma, brotli, zstd, compress (only gzip supported)

### General

- `.ignore` file support (we only support `.gitignore`)
- Context messages in JSON output (`-A/-B/-C` context not output as separate messages)

## License

ripgrep is licensed under the MIT license. See the [ripgrep repository](https://github.com/BurntSushi/ripgrep) for details.
