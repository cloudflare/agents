/**
 * Shared search engine for grep and rg commands
 *
 * Provides core text searching functionality:
 * - Line-by-line content matching
 * - Context lines (before/after)
 * - Regex building for different modes (basic, extended, fixed, perl)
 */

export {
  type SearchOptions,
  type SearchResult,
  searchContent
} from "./matcher";
export {
  buildRegex,
  convertReplacement,
  type RegexMode,
  type RegexOptions,
  type RegexResult
} from "./regex";
