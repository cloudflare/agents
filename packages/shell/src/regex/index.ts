/**
 * Centralized regex handling for user-provided patterns.
 *
 * This module provides ReDoS-safe regex execution for all user-provided patterns.
 * Currently uses native JavaScript RegExp, designed to be swapped to RE2.
 *
 * Usage:
 *   import { createUserRegex, UserRegex } from '../regex/index';
 *
 *   // For user-provided patterns (from grep, sed, awk, bash =~, etc.)
 *   const regex = createUserRegex(userPattern, 'gi');
 *   const matches = regex.match(input);
 *
 *   // For internal patterns (that we control), you can still use RegExp directly
 *   const internalRegex = /^[a-z]+$/;
 */

export {
  ConstantRegex,
  createUserRegex,
  type RegexLike,
  type ReplaceCallback,
  UserRegex
} from "./user-regex";
