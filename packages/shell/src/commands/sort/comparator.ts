// Comparator functions for sort command

import type { KeySpec, SortOptions } from "./types";

// Human-readable size suffixes (case insensitive) - Map prevents prototype pollution
const SIZE_SUFFIXES = new Map<string, number>([
  ["", 1],
  ["k", 1024],
  ["m", 1024 ** 2],
  ["g", 1024 ** 3],
  ["t", 1024 ** 4],
  ["p", 1024 ** 5],
  ["e", 1024 ** 6]
]);

// Month names for -M - Map prevents prototype pollution
const MONTHS = new Map<string, number>([
  ["jan", 1],
  ["feb", 2],
  ["mar", 3],
  ["apr", 4],
  ["may", 5],
  ["jun", 6],
  ["jul", 7],
  ["aug", 8],
  ["sep", 9],
  ["oct", 10],
  ["nov", 11],
  ["dec", 12]
]);

/**
 * Parse a human-readable size like "1K", "2.5M", "3G"
 */
function parseHumanSize(s: string): number {
  const trimmed = s.trim();
  const match = trimmed.match(
    /^([+-]?\d*\.?\d+)\s*([kmgtpeKMGTPE])?[iI]?[bB]?$/
  );
  if (!match) {
    // Try to parse as plain number
    const num = parseFloat(trimmed);
    return Number.isNaN(num) ? 0 : num;
  }
  const num = parseFloat(match[1]);
  const suffix = (match[2] || "").toLowerCase();
  const multiplier = SIZE_SUFFIXES.get(suffix) ?? 1;
  return num * multiplier;
}

/**
 * Parse month name and return sort order (0 for unknown)
 */
function parseMonth(s: string): number {
  const trimmed = s.trim().toLowerCase().slice(0, 3);
  return MONTHS.get(trimmed) ?? 0;
}

/**
 * Compare version strings naturally (e.g., "1.2" < "1.10")
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split(/(\d+)/);
  const partsB = b.split(/(\d+)/);
  const maxLen = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < maxLen; i++) {
    const partA = partsA[i] || "";
    const partB = partsB[i] || "";

    // Check if both parts are numeric
    const numA = /^\d+$/.test(partA) ? parseInt(partA, 10) : null;
    const numB = /^\d+$/.test(partB) ? parseInt(partB, 10) : null;

    if (numA !== null && numB !== null) {
      // Both numeric - compare as numbers
      if (numA !== numB) return numA - numB;
    } else {
      // At least one is non-numeric - compare as strings
      if (partA !== partB) return partA.localeCompare(partB);
    }
  }
  return 0;
}

/**
 * Apply dictionary order: keep only alphanumeric and blanks
 */
function toDictionaryOrder(s: string): string {
  return s.replace(/[^a-zA-Z0-9\s]/g, "");
}

/**
 * Extract key value from a line based on key specification
 */
function extractKeyValue(
  line: string,
  key: KeySpec,
  delimiter: string | null
): string {
  // Split line into fields
  const splitPattern = delimiter !== null ? delimiter : /\s+/;
  const fields = line.split(splitPattern);

  // Get start field (0-indexed internally)
  const startFieldIdx = key.startField - 1;
  if (startFieldIdx >= fields.length) {
    return "";
  }

  // If no end field specified, use just the start field
  if (key.endField === undefined) {
    let field = fields[startFieldIdx] || "";

    // Handle character position within field
    if (key.startChar !== undefined) {
      field = field.slice(key.startChar - 1);
    }

    // Handle ignore leading blanks
    if (key.ignoreLeading) {
      field = field.trimStart();
    }

    return field;
  }

  // Range of fields
  const endFieldIdx = Math.min(key.endField - 1, fields.length - 1);

  // Build the key value from multiple fields
  let result = "";

  for (let i = startFieldIdx; i <= endFieldIdx && i < fields.length; i++) {
    let field = fields[i] || "";

    if (i === startFieldIdx && key.startChar !== undefined) {
      // Start character position in first field
      field = field.slice(key.startChar - 1);
    }

    if (i === endFieldIdx && key.endChar !== undefined) {
      // End character position in last field
      const endIdx =
        i === startFieldIdx && key.startChar !== undefined
          ? key.endChar - key.startChar + 1
          : key.endChar;
      field = field.slice(0, endIdx);
    }

    if (i > startFieldIdx) {
      // Add delimiter between fields
      result += delimiter || " ";
    }
    result += field;
  }

  // Handle ignore leading blanks
  if (key.ignoreLeading) {
    result = result.trimStart();
  }

  return result;
}

interface CompareOptions {
  numeric?: boolean;
  ignoreCase?: boolean;
  humanNumeric?: boolean;
  versionSort?: boolean;
  dictionaryOrder?: boolean;
  monthSort?: boolean;
}

/**
 * Compare two values, handling various sort modes
 */
function compareValues(a: string, b: string, opts: CompareOptions): number {
  let valA = a;
  let valB = b;

  // Apply dictionary order first (removes non-alphanumeric)
  if (opts.dictionaryOrder) {
    valA = toDictionaryOrder(valA);
    valB = toDictionaryOrder(valB);
  }

  // Apply case folding
  if (opts.ignoreCase) {
    valA = valA.toLowerCase();
    valB = valB.toLowerCase();
  }

  // Month sort
  if (opts.monthSort) {
    const monthA = parseMonth(valA);
    const monthB = parseMonth(valB);
    return monthA - monthB;
  }

  // Human numeric sort (1K, 2M, etc.)
  if (opts.humanNumeric) {
    const sizeA = parseHumanSize(valA);
    const sizeB = parseHumanSize(valB);
    return sizeA - sizeB;
  }

  // Version sort
  if (opts.versionSort) {
    return compareVersions(valA, valB);
  }

  // Numeric sort
  if (opts.numeric) {
    const numA = parseFloat(valA) || 0;
    const numB = parseFloat(valB) || 0;
    return numA - numB;
  }

  // String comparison
  return valA.localeCompare(valB);
}

/**
 * Create a comparison function for sorting
 */
export function createComparator(
  options: SortOptions
): (a: string, b: string) => number {
  const {
    keys,
    fieldDelimiter,
    numeric: globalNumeric,
    ignoreCase: globalIgnoreCase,
    reverse: globalReverse,
    humanNumeric: globalHumanNumeric,
    versionSort: globalVersionSort,
    dictionaryOrder: globalDictionaryOrder,
    monthSort: globalMonthSort,
    ignoreLeadingBlanks: globalIgnoreLeadingBlanks,
    stable: globalStable
  } = options;

  return (a: string, b: string): number => {
    let lineA = a;
    let lineB = b;

    // Apply ignore leading blanks globally
    if (globalIgnoreLeadingBlanks) {
      lineA = lineA.trimStart();
      lineB = lineB.trimStart();
    }

    // If no keys specified, compare whole lines
    if (keys.length === 0) {
      const opts: CompareOptions = {
        numeric: globalNumeric,
        ignoreCase: globalIgnoreCase,
        humanNumeric: globalHumanNumeric,
        versionSort: globalVersionSort,
        dictionaryOrder: globalDictionaryOrder,
        monthSort: globalMonthSort
      };

      const result = compareValues(lineA, lineB, opts);

      if (result !== 0) {
        return globalReverse ? -result : result;
      }

      // Tiebreaker: use original lines unless stable sort
      if (!globalStable) {
        const tiebreaker = a.localeCompare(b);
        return globalReverse ? -tiebreaker : tiebreaker;
      }
      return 0;
    }

    // Compare by each key in order
    for (const key of keys) {
      let valA = extractKeyValue(lineA, key, fieldDelimiter);
      let valB = extractKeyValue(lineB, key, fieldDelimiter);

      // Apply per-key ignore leading blanks
      if (key.ignoreLeading) {
        valA = valA.trimStart();
        valB = valB.trimStart();
      }

      // Use per-key modifiers or fall back to global options
      const opts: CompareOptions = {
        numeric: key.numeric ?? globalNumeric,
        ignoreCase: key.ignoreCase ?? globalIgnoreCase,
        humanNumeric: key.humanNumeric ?? globalHumanNumeric,
        versionSort: key.versionSort ?? globalVersionSort,
        dictionaryOrder: key.dictionaryOrder ?? globalDictionaryOrder,
        monthSort: key.monthSort ?? globalMonthSort
      };
      const useReverse = key.reverse ?? globalReverse;

      const result = compareValues(valA, valB, opts);

      if (result !== 0) {
        return useReverse ? -result : result;
      }
    }

    // All keys equal, compare whole lines as tiebreaker unless stable
    if (!globalStable) {
      const tiebreaker = a.localeCompare(b);
      return globalReverse ? -tiebreaker : tiebreaker;
    }
    return 0;
  };
}

/**
 * Filter unique lines based on key values or whole line
 */
export function filterUnique(lines: string[], options: SortOptions): string[] {
  if (options.keys.length === 0) {
    // No keys - use whole line for uniqueness
    if (options.ignoreCase) {
      const seen = new Set<string>();
      return lines.filter((line) => {
        const key = line.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    return [...new Set(lines)];
  }

  // Use first key for uniqueness comparison
  const key = options.keys[0];
  const seen = new Set<string>();

  return lines.filter((line) => {
    let keyVal = extractKeyValue(line, key, options.fieldDelimiter);
    if (key.ignoreCase ?? options.ignoreCase) {
      keyVal = keyVal.toLowerCase();
    }
    if (seen.has(keyVal)) return false;
    seen.add(keyVal);
    return true;
  });
}
