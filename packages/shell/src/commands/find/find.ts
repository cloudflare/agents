import type { DirentEntry } from "../../fs/interface";
import { shellJoinArgs } from "../../helpers/shell-quote";
import type {
  Command,
  CommandContext,
  ExecResult,
  TraceCallback
} from "../../types";
import { formatMode } from "../format-mode";

// Use a larger batch size for find to maximize parallel I/O
const FIND_BATCH_SIZE = 500;

// Tracing helpers
interface TraceCounters {
  readdirCalls: number;
  readdirTime: number;
  statCalls: number;
  statTime: number;
  evalCalls: number;
  evalTime: number;
  nodeCount: number;
  batchCount: number;
  batchTime: number;
  earlyPrunes: number;
}

function createTraceCounters(): TraceCounters {
  return {
    readdirCalls: 0,
    readdirTime: 0,
    statCalls: 0,
    statTime: 0,
    evalCalls: 0,
    evalTime: 0,
    nodeCount: 0,
    batchCount: 0,
    batchTime: 0,
    earlyPrunes: 0
  };
}

function emitTraceSummary(
  trace: TraceCallback,
  counters: TraceCounters,
  totalMs: number
): void {
  trace({
    category: "find",
    name: "summary",
    durationMs: totalMs,
    details: {
      readdirCalls: counters.readdirCalls,
      readdirTimeMs: counters.readdirTime,
      statCalls: counters.statCalls,
      statTimeMs: counters.statTime,
      evalCalls: counters.evalCalls,
      evalTimeMs: counters.evalTime,
      nodeCount: counters.nodeCount,
      batchCount: counters.batchCount,
      batchTimeMs: counters.batchTime,
      earlyPrunes: counters.earlyPrunes,
      otherTimeMs:
        totalMs -
        counters.readdirTime -
        counters.statTime -
        counters.evalTime -
        counters.batchTime
    }
  });
}

import { hasHelpFlag, showHelp } from "../help";
import {
  applyWidth,
  parseWidthPrecision,
  processEscapes
} from "../printf/escapes";
import {
  collectNewerRefs,
  evaluateExpressionWithPrune,
  evaluateForEarlyPrune,
  evaluateSimpleExpression,
  expressionHasPrune,
  expressionNeedsEmptyCheck,
  expressionNeedsStatMetadata,
  extractPathPruningHints,
  isSimpleExpression
} from "./matcher";
import { parseExpressions } from "./parser";
import type { EvalContext, EvalResult } from "./types";

const findHelp = {
  name: "find",
  summary: "search for files in a directory hierarchy",
  usage: "find [path...] [expression]",
  options: [
    "-name PATTERN    file name matches shell pattern PATTERN",
    "-iname PATTERN   like -name but case insensitive",
    "-path PATTERN    file path matches shell pattern PATTERN",
    "-ipath PATTERN   like -path but case insensitive",
    "-regex PATTERN   file path matches regular expression PATTERN",
    "-iregex PATTERN  like -regex but case insensitive",
    "-type TYPE       file is of type: f (regular file), d (directory)",
    "-empty           file is empty or directory is empty",
    "-mtime N         file's data was modified N*24 hours ago",
    "-newer FILE      file was modified more recently than FILE",
    "-size N[ckMGb]   file uses N units of space (c=bytes, k=KB, M=MB, G=GB, b=512B blocks)",
    "-perm MODE       file's permission bits are exactly MODE (octal)",
    "-perm -MODE      all permission bits MODE are set",
    "-perm /MODE      any permission bits MODE are set",
    "-maxdepth LEVELS descend at most LEVELS directories",
    "-mindepth LEVELS do not apply tests at levels less than LEVELS",
    "-depth           process directory contents before directory itself",
    "-prune           do not descend into this directory",
    "-not, !          negate the following expression",
    "-a, -and         logical AND (default)",
    "-o, -or          logical OR",
    "-exec CMD {} ;   execute CMD on each file ({} is replaced by filename)",
    "-exec CMD {} +   execute CMD with multiple files at once",
    "-print           print the full file name (default action)",
    "-print0          print the full file name followed by a null character",
    "-printf FORMAT   print FORMAT with directives: %f %h %p %P %s %d %m %M %t",
    "-delete          delete found files/directories",
    "    --help       display this help and exit"
  ]
};

// Predicates that take arguments
const PREDICATES_WITH_ARGS_SET = new Set([
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-regex",
  "-iregex",
  "-type",
  "-maxdepth",
  "-mindepth",
  "-mtime",
  "-newer",
  "-size",
  "-perm"
]);

export const findCommand: Command = {
  name: "find",
  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(findHelp);
    }

    const searchPaths: string[] = [];
    let maxDepth: number | null = null;
    let minDepth: number | null = null;
    let depthFirst = false;

    // Find all path arguments and parse -maxdepth/-mindepth/-depth
    // Paths come before any predicates (arguments starting with -)
    let expressionsStarted = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-maxdepth" && i + 1 < args.length) {
        expressionsStarted = true;
        maxDepth = parseInt(args[++i], 10);
      } else if (arg === "-mindepth" && i + 1 < args.length) {
        expressionsStarted = true;
        minDepth = parseInt(args[++i], 10);
      } else if (arg === "-depth") {
        expressionsStarted = true;
        depthFirst = true;
      } else if (arg === "-exec") {
        expressionsStarted = true;
        // Skip -exec and all arguments until terminator (; or +)
        i++;
        while (i < args.length && args[i] !== ";" && args[i] !== "+") {
          i++;
        }
        // i now points to the terminator, loop will increment past it
      } else if (
        !arg.startsWith("-") &&
        arg !== ";" &&
        arg !== "+" &&
        arg !== "(" &&
        arg !== ")" &&
        arg !== "\\(" &&
        arg !== "\\)" &&
        arg !== "!"
      ) {
        // This is a path if we haven't started expressions yet
        if (!expressionsStarted) {
          searchPaths.push(arg);
        }
      } else if (PREDICATES_WITH_ARGS_SET.has(arg)) {
        expressionsStarted = true;
        // Skip value arguments for predicates that take arguments
        i++;
      } else if (
        arg.startsWith("-") ||
        arg === "(" ||
        arg === "\\(" ||
        arg === "!"
      ) {
        expressionsStarted = true;
      }
    }

    // Default to current directory if no paths specified
    if (searchPaths.length === 0) {
      searchPaths.push(".");
    }

    // Parse expressions
    const { expr, error, actions } = parseExpressions(args, 0);

    // Return error for unknown predicates
    if (error) {
      return { stdout: "", stderr: error, exitCode: 1 };
    }

    // Check if there's an explicit -print in the expression
    const hasExplicitPrint = actions.some((a) => a.type === "print");

    // Determine if we should use default printing (when no actions at all)
    const useDefaultPrint = actions.length === 0;

    // Result type for find entries
    interface FindResult {
      path: string;
      name: string;
      size: number;
      mtime: number;
      mode: number;
      isDirectory: boolean;
      depth: number;
      startingPoint: string;
    }

    const results: string[] = [];
    // Extended results for -printf (stores metadata for each result)
    const hasPrintfAction = actions.some((a) => a.type === "printf");
    const printfResults: FindResult[] = [];
    let stderr = "";
    let exitCode = 0;

    // Collect and resolve -newer reference file mtimes
    const newerRefPaths = collectNewerRefs(expr);
    const newerRefTimes = new Map<string, number>();

    for (const refPath of newerRefPaths) {
      const refFullPath = ctx.fs.resolvePath(ctx.cwd, refPath);
      try {
        const refStat = await ctx.fs.stat(refFullPath);
        newerRefTimes.set(refPath, refStat.mtime?.getTime() ?? Date.now());
      } catch {
        // Reference file doesn't exist, -newer will always be false
      }
    }

    // Check if printf format needs stat metadata
    // Simple directives: %f %h %p %P %d %% don't need stat
    // Stat-dependent: %s %m %M %t %T need stat
    const printfNeedsStat = actions.some((a) => {
      if (a.type !== "printf") return false;
      // Check for stat-dependent directives: %s %m %M %t %T
      // But skip escaped %% and handle width/precision modifiers like %10s or %-5.2s
      const format = a.format.replace(/%%/g, "");
      return /%[-+]?[0-9]*\.?[0-9]*(s|m|M|t|T)/.test(format);
    });

    // Check if expression needs full stat metadata (optimization)
    const needsStatMetadata =
      expressionNeedsStatMetadata(expr) || printfNeedsStat;

    // Check if expression uses -empty (needs to read directories to count entries)
    const needsEmptyCheck = expressionNeedsEmptyCheck(expr);

    // Extract path pattern pruning hints (for patterns like "*/pulls/*.json")
    const pathPruningHints = extractPathPruningHints(expr);

    // Check if expression has -prune (for early prune optimization)
    const hasPruneExpr = expressionHasPrune(expr);

    // Check if expression is simple (only name/path/type/prune/print)
    // Simple expressions can use the fast-path that avoids EvalContext allocation
    const isSimpleExpr = isSimpleExpression(expr);

    // Check if readdirWithFileTypes is available (for optimization)
    const hasReaddirWithFileTypes =
      typeof ctx.fs.readdirWithFileTypes === "function";

    // Process each search path
    for (let searchPath of searchPaths) {
      // Normalize trailing slashes (except for root "/")
      if (searchPath.length > 1 && searchPath.endsWith("/")) {
        searchPath = searchPath.slice(0, -1);
      }
      const basePath = ctx.fs.resolvePath(ctx.cwd, searchPath);

      // Check if path exists
      try {
        await ctx.fs.stat(basePath);
      } catch {
        stderr += `find: ${searchPath}: No such file or directory\n`;
        exitCode = 1;
        continue;
      }

      // Work item for iterative traversal
      interface WorkItem {
        path: string;
        depth: number;
        typeInfo?: { isFile: boolean; isDirectory: boolean };
        // For ordered results: index where this item's results go
        resultIndex: number;
      }

      // Processed node info
      interface ProcessedNode {
        relativePath: string;
        name: string;
        isFile: boolean;
        isDirectory: boolean;
        isEmpty: boolean;
        stat?: Awaited<ReturnType<typeof ctx.fs.stat>>;
        depth: number;
        children: WorkItem[];
        pruned: boolean;
      }

      // Tracing counters
      const traceCounters = createTraceCounters();
      const traceStartTime = Date.now();

      // Process a single node: get stat, children, check prune
      async function processNode(
        item: WorkItem
      ): Promise<ProcessedNode | null> {
        const { path: currentPath, depth, typeInfo } = item;
        traceCounters.nodeCount++;

        // Check maxdepth (default safety limit of 256 if not specified)
        if (depth > (maxDepth ?? 256)) {
          return null;
        }

        // Get type info
        let isFile: boolean;
        let isDirectory: boolean;
        let stat: Awaited<ReturnType<typeof ctx.fs.stat>> | undefined;

        if (typeInfo && !needsStatMetadata) {
          isFile = typeInfo.isFile;
          isDirectory = typeInfo.isDirectory;
        } else {
          try {
            const statStart = Date.now();
            stat = await ctx.fs.stat(currentPath);
            traceCounters.statCalls++;
            traceCounters.statTime += Date.now() - statStart;
          } catch {
            return null;
          }
          if (!stat) return null;
          isFile = stat.isFile;
          isDirectory = stat.isDirectory;
        }

        // Compute name and relative path
        let name: string;
        if (currentPath === basePath) {
          name = searchPath.split("/").pop() || searchPath;
        } else {
          name = currentPath.split("/").pop() || "";
        }

        const relativePath =
          currentPath === basePath
            ? searchPath
            : searchPath === "."
              ? `./${currentPath.slice(basePath === "/" ? basePath.length : basePath.length + 1)}`
              : searchPath + currentPath.slice(basePath.length);

        // Get children for directories
        let children: WorkItem[] = [];
        let entriesWithTypes: DirentEntry[] | null = null;
        let entries: string[] | null = null;

        // Early prune optimization: check if we can skip this directory before readdir
        // This avoids reading directory contents for directories that will be pruned
        let earlyPruned = false;
        if (isDirectory && hasPruneExpr && !depthFirst) {
          const earlyResult = evaluateForEarlyPrune(expr, {
            name,
            relativePath,
            isFile,
            isDirectory
          });
          earlyPruned = earlyResult.shouldPrune;
          if (earlyPruned) {
            traceCounters.earlyPrunes++;
          }
        }

        // Optimization: skip reading directory contents if we're at maxdepth
        // Exception: if -empty is used, we need to read to check if directory is empty
        const atMaxDepth = depth >= (maxDepth ?? 256);
        // Path pattern pruning: for patterns like "*/pulls/*.json", don't descend into "pulls" subdirs
        // But we still need to read the directory to check its direct children (files)
        const inTerminalDir =
          pathPruningHints.terminalDirName !== null &&
          name === pathPruningHints.terminalDirName;
        const shouldDescendIntoSubdirs =
          !atMaxDepth && !inTerminalDir && !earlyPruned;
        const shouldReadDir =
          (shouldDescendIntoSubdirs || needsEmptyCheck || inTerminalDir) &&
          !earlyPruned;

        if (isDirectory && shouldReadDir) {
          const readdirStart = Date.now();
          if (hasReaddirWithFileTypes && ctx.fs.readdirWithFileTypes) {
            entriesWithTypes = await ctx.fs.readdirWithFileTypes(currentPath);
            entries = entriesWithTypes.map((e) => e.name);
            traceCounters.readdirCalls++;
            traceCounters.readdirTime += Date.now() - readdirStart;
            // Create children work items
            // In terminal directory (e.g., "pulls" for pattern "*/pulls/*.json"),
            // only process files, not subdirectories
            if (shouldDescendIntoSubdirs) {
              children = entriesWithTypes.map((entry, idx) => ({
                path:
                  currentPath === "/"
                    ? `/${entry.name}`
                    : `${currentPath}/${entry.name}`,
                depth: depth + 1,
                typeInfo: {
                  isFile: entry.isFile,
                  isDirectory: entry.isDirectory
                },
                resultIndex: idx
              }));
            } else if (inTerminalDir) {
              // Only include files (not subdirectories) as children
              // Also filter by extension if we have that hint
              const extFilter = pathPruningHints.requiredExtension;
              children = entriesWithTypes
                .filter(
                  (entry) =>
                    entry.isFile &&
                    (!extFilter || entry.name.endsWith(extFilter))
                )
                .map((entry, idx) => ({
                  path:
                    currentPath === "/"
                      ? `/${entry.name}`
                      : `${currentPath}/${entry.name}`,
                  depth: depth + 1,
                  typeInfo: {
                    isFile: entry.isFile,
                    isDirectory: entry.isDirectory
                  },
                  resultIndex: idx
                }));
            }
          } else {
            entries = await ctx.fs.readdir(currentPath);
            traceCounters.readdirCalls++;
            traceCounters.readdirTime += Date.now() - readdirStart;
            // Create children work items
            if (shouldDescendIntoSubdirs) {
              children = entries.map((entry, idx) => ({
                path:
                  currentPath === "/" ? `/${entry}` : `${currentPath}/${entry}`,
                depth: depth + 1,
                resultIndex: idx
              }));
            }
            // Note: when inTerminalDir and no readdirWithFileTypes,
            // we can't filter by type, so we process all children
            // (they'll be filtered during evaluation anyway)
          }
        }

        const isEmpty = isFile
          ? (stat?.size ?? 0) === 0
          : entries !== null && entries.length === 0;

        // Check for pruning (only in pre-order mode when expression has -prune)
        // If we already early-pruned, use that result
        // Skip this evaluation entirely if there's no -prune in the expression
        let pruned = earlyPruned;
        if (!depthFirst && expr !== null && !earlyPruned && hasPruneExpr) {
          const evalStart = Date.now();
          const evalCtx: EvalContext = {
            name,
            relativePath,
            isFile,
            isDirectory,
            isEmpty,
            mtime: stat?.mtime?.getTime() ?? Date.now(),
            size: stat?.size ?? 0,
            mode: stat?.mode ?? 0o644,
            newerRefTimes
          };
          const evalResult = evaluateExpressionWithPrune(expr, evalCtx);
          pruned = evalResult.pruned;
          traceCounters.evalCalls++;
          traceCounters.evalTime += Date.now() - evalStart;
        }

        return {
          relativePath,
          name,
          isFile,
          isDirectory,
          isEmpty,
          stat,
          depth,
          children: pruned ? [] : children,
          pruned
        };
      }

      // Check if node matches and should be printed
      function shouldPrintNode(node: ProcessedNode): {
        print: boolean;
        printfData: FindResult | null;
      } {
        const atOrBeyondMinDepth = minDepth === null || node.depth >= minDepth;
        let matches = atOrBeyondMinDepth;
        let shouldPrint = false;

        if (matches && expr !== null) {
          const evalStart = Date.now();
          let evalResult: EvalResult;

          // Use fast-path for simple expressions to avoid EvalContext allocation
          if (isSimpleExpr) {
            evalResult = evaluateSimpleExpression(
              expr,
              node.name,
              node.relativePath,
              node.isFile,
              node.isDirectory
            );
          } else {
            const evalCtx: EvalContext = {
              name: node.name,
              relativePath: node.relativePath,
              isFile: node.isFile,
              isDirectory: node.isDirectory,
              isEmpty: node.isEmpty,
              mtime: node.stat?.mtime?.getTime() ?? Date.now(),
              size: node.stat?.size ?? 0,
              mode: node.stat?.mode ?? 0o644,
              newerRefTimes
            };
            evalResult = evaluateExpressionWithPrune(expr, evalCtx);
          }

          matches = evalResult.matches;
          shouldPrint = hasExplicitPrint ? evalResult.printed : matches;
          traceCounters.evalCalls++;
          traceCounters.evalTime += Date.now() - evalStart;
        } else if (matches) {
          shouldPrint = true;
        }

        if (!shouldPrint) {
          return { print: false, printfData: null };
        }

        const printfData = hasPrintfAction
          ? {
              path: node.relativePath,
              name: node.name,
              size: node.stat?.size ?? 0,
              mtime: node.stat?.mtime?.getTime() ?? Date.now(),
              mode: node.stat?.mode ?? 0o644,
              isDirectory: node.isDirectory,
              depth: node.depth,
              startingPoint: searchPath
            }
          : null;

        return { print: true, printfData };
      }

      // Result collection for ordered results
      interface NodeResult {
        paths: string[];
        printfData: FindResult[];
      }

      // Iterative depth-first traversal with parallel processing
      // Uses work array with slot-based result collection for ordering
      async function findIterative(): Promise<NodeResult> {
        const finalResult: NodeResult = { paths: [], printfData: [] };

        // For depth-first (post-order), we use a different strategy:
        // 1. Discover all nodes level by level (BFS with parallel batches)
        // 2. Track parent-child relationships
        // 3. Build results bottom-up maintaining tree order

        if (depthFirst) {
          // Phase 1: Discover all nodes (BFS to get structure)
          interface DiscoveredNode {
            node: ProcessedNode;
            parentIndex: number; // -1 for root
            childIndices: number[]; // filled in after all children discovered
          }

          const discovered: DiscoveredNode[] = [];

          // Queue item includes parent index for tracking
          interface QueueItem {
            item: WorkItem;
            parentIndex: number;
            childOrderInParent: number; // which child of parent this is
          }

          const workQueue: QueueItem[] = [
            {
              item: { path: basePath, depth: 0, resultIndex: 0 },
              parentIndex: -1,
              childOrderInParent: 0
            }
          ];

          // Track which discovered index each queue item will become
          const parentChildMap = new Map<number, number[]>(); // parentIdx -> [childIdx in order]

          // BFS to discover all nodes with parallel processing
          while (workQueue.length > 0) {
            const batchStart = Date.now();
            const batch = workQueue.splice(0, FIND_BATCH_SIZE);
            const nodes = await Promise.all(
              batch.map((q) => processNode(q.item))
            );
            traceCounters.batchCount++;
            traceCounters.batchTime += Date.now() - batchStart;

            for (let i = 0; i < batch.length; i++) {
              const node = nodes[i];
              const queueItem = batch[i];
              if (!node) continue;

              const thisIndex = discovered.length;

              // Register this node with its parent
              if (queueItem.parentIndex >= 0) {
                const siblings =
                  parentChildMap.get(queueItem.parentIndex) || [];
                siblings.push(thisIndex);
                parentChildMap.set(queueItem.parentIndex, siblings);
              }

              discovered.push({
                node,
                parentIndex: queueItem.parentIndex,
                childIndices: [] // will be filled from parentChildMap
              });

              // Add children to work queue
              for (let j = 0; j < node.children.length; j++) {
                workQueue.push({
                  item: node.children[j],
                  parentIndex: thisIndex,
                  childOrderInParent: j
                });
              }
            }
          }

          // Fill in childIndices from parentChildMap
          for (const [parentIdx, childIndices] of parentChildMap) {
            if (parentIdx >= 0 && parentIdx < discovered.length) {
              discovered[parentIdx].childIndices = childIndices;
            }
          }

          // Phase 2: Build result in post-order using recursive collection
          // This ensures children come before parent in the correct sibling order
          function collectPostOrder(index: number): NodeResult {
            const result: NodeResult = { paths: [], printfData: [] };
            const entry = discovered[index];
            if (!entry) return result;

            // First, collect all children's results (in order)
            for (const childIndex of entry.childIndices) {
              const childResult = collectPostOrder(childIndex);
              result.paths.push(...childResult.paths);
              result.printfData.push(...childResult.printfData);
            }

            // Then, add this node's result
            const { print, printfData } = shouldPrintNode(entry.node);
            if (print) {
              result.paths.push(entry.node.relativePath);
              if (printfData) {
                result.printfData.push(printfData);
              }
            }

            return result;
          }

          // Start from root (index 0)
          if (discovered.length > 0) {
            const rootResult = collectPostOrder(0);
            finalResult.paths.push(...rootResult.paths);
            finalResult.printfData.push(...rootResult.printfData);
          }
        } else {
          // Pre-order traversal using BFS with batched processing
          // This maximizes parallelism while maintaining pre-order output

          interface NodeWithOrder {
            node: ProcessedNode;
            orderIndex: number;
          }

          const nodeResults: Map<
            number,
            { path: string; printfData: FindResult | null }
          > = new Map();
          let orderCounter = 0;

          // BFS queue with order tracking
          const workQueue: Array<{ item: WorkItem; orderIndex: number }> = [
            {
              item: { path: basePath, depth: 0, resultIndex: 0 },
              orderIndex: orderCounter++
            }
          ];

          // Track child order indices for each parent
          const childOrders: Map<number, number[]> = new Map();

          while (workQueue.length > 0) {
            // Process all items in the queue in parallel batches
            const batchStart = Date.now();
            const batch = workQueue.splice(0, FIND_BATCH_SIZE);
            const processed: Array<NodeWithOrder | null> = await Promise.all(
              batch.map(async ({ item, orderIndex }) => {
                const node = await processNode(item);
                return node ? { node, orderIndex } : null;
              })
            );
            traceCounters.batchCount++;
            traceCounters.batchTime += Date.now() - batchStart;

            for (const result of processed) {
              if (!result) continue;
              const { node, orderIndex } = result;

              // Check if this node should be printed
              const { print, printfData } = shouldPrintNode(node);
              if (print) {
                nodeResults.set(orderIndex, {
                  path: node.relativePath,
                  printfData
                });
              }

              // Add children to work queue with consecutive order indices
              if (node.children.length > 0) {
                const childIndices: number[] = [];
                for (const child of node.children) {
                  const childOrder = orderCounter++;
                  childIndices.push(childOrder);
                  workQueue.push({ item: child, orderIndex: childOrder });
                }
                childOrders.set(orderIndex, childIndices);
              }
            }
          }

          // Build result in pre-order by walking the tree structure
          function collectPreOrder(orderIndex: number): void {
            const nodeResult = nodeResults.get(orderIndex);
            if (nodeResult) {
              finalResult.paths.push(nodeResult.path);
              if (nodeResult.printfData) {
                finalResult.printfData.push(nodeResult.printfData);
              }
            }
            const children = childOrders.get(orderIndex);
            if (children) {
              for (const childIndex of children) {
                collectPreOrder(childIndex);
              }
            }
          }

          collectPreOrder(0);
        }

        return finalResult;
      }

      const searchResult = await findIterative();
      results.push(...searchResult.paths);
      printfResults.push(...searchResult.printfData);

      // Emit trace summary for this search path
      if (ctx.trace) {
        const totalMs = Date.now() - traceStartTime;
        emitTraceSummary(ctx.trace, traceCounters, totalMs);
        ctx.trace({
          category: "find",
          name: "searchPath",
          durationMs: totalMs,
          details: {
            path: searchPath,
            resultsFound: searchResult.paths.length
          }
        });
      }
    }

    let stdout = "";

    // Execute actions if any
    if (actions.length > 0) {
      for (const action of actions) {
        switch (action.type) {
          case "print":
            // When -print is in the expression (hasExplicitPrint), results are already
            // populated based on when -print was triggered during evaluation.
            // Just output them here.
            stdout += results.length > 0 ? `${results.join("\n")}\n` : "";
            break;

          case "print0":
            stdout += results.length > 0 ? `${results.join("\0")}\0` : "";
            break;

          case "delete": {
            // Delete files in reverse order (depth-first) to handle directories
            const sortedForDelete = [...results].sort(
              (a, b) => b.length - a.length
            );
            for (const file of sortedForDelete) {
              const fullPath = ctx.fs.resolvePath(ctx.cwd, file);
              try {
                await ctx.fs.rm(fullPath, { recursive: false });
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                stderr += `find: cannot delete '${file}': ${msg}\n`;
                exitCode = 1;
              }
            }
            break;
          }

          case "printf":
            for (const r of printfResults) {
              stdout += formatFindPrintf(action.format, r);
            }
            break;

          case "exec":
            if (!ctx.exec) {
              return {
                stdout: "",
                stderr: "find: -exec not supported in this context\n",
                exitCode: 1
              };
            }
            if (action.batchMode) {
              // -exec ... + : execute command once with all files
              const cmdWithFiles: string[] = [];
              for (const part of action.command) {
                if (part === "{}") {
                  cmdWithFiles.push(...results);
                } else {
                  cmdWithFiles.push(part);
                }
              }
              const result = await ctx.exec(shellJoinArgs([cmdWithFiles[0]]), {
                cwd: ctx.cwd,
                signal: ctx.signal,
                args: cmdWithFiles.slice(1)
              });
              stdout += result.stdout;
              stderr += result.stderr;
              if (result.exitCode !== 0) {
                exitCode = result.exitCode;
              }
            } else {
              // -exec ... ; : execute command for each file
              for (const file of results) {
                const cmdWithFile = action.command.map((part) =>
                  part === "{}" ? file : part
                );
                const result = await ctx.exec(shellJoinArgs([cmdWithFile[0]]), {
                  cwd: ctx.cwd,
                  signal: ctx.signal,
                  args: cmdWithFile.slice(1)
                });
                stdout += result.stdout;
                stderr += result.stderr;
                if (result.exitCode !== 0) {
                  exitCode = result.exitCode;
                }
              }
            }
            break;
        }
      }
    } else if (useDefaultPrint) {
      // Default: print with newline separator
      stdout = results.length > 0 ? `${results.join("\n")}\n` : "";
    }

    return { stdout, stderr, exitCode };
  }
};

/**
 * Format a find -printf format string
 * Supported directives (all support optional width/precision like %-20.10f):
 * %f - file basename (filename without directory)
 * %h - directory name (dirname)
 * %p - full path
 * %P - path without starting point
 * %s - file size in bytes
 * %d - depth in directory tree
 * %m - permissions in octal (without leading 0)
 * %M - symbolic permissions like -rwxr-xr-x
 * %t - modification time in ctime format
 * %T@ - modification time as seconds since epoch
 * %Tk - modification time with strftime format k
 * %% - literal %
 * Also processes escape sequences: \n, \t, etc.
 */
function formatFindPrintf(
  format: string,
  result: {
    path: string;
    name: string;
    size: number;
    mtime: number;
    mode: number;
    isDirectory: boolean;
    depth: number;
    startingPoint: string;
  }
): string {
  // First process escape sequences
  const processed = processEscapes(format);

  let output = "";
  let i = 0;

  while (i < processed.length) {
    if (processed[i] === "%" && i + 1 < processed.length) {
      i++; // skip %

      // Check for %% first
      if (processed[i] === "%") {
        output += "%";
        i++;
        continue;
      }

      // Parse optional width/precision (e.g., %-20.10)
      const [width, precision, consumed] = parseWidthPrecision(processed, i);
      i += consumed;

      if (i >= processed.length) {
        output += "%";
        break;
      }

      const directive = processed[i];
      let value: string;

      switch (directive) {
        case "f":
          // Filename (basename)
          value = result.name;
          i++;
          break;
        case "h": {
          // Directory (dirname)
          const lastSlash = result.path.lastIndexOf("/");
          value = lastSlash > 0 ? result.path.slice(0, lastSlash) : ".";
          i++;
          break;
        }
        case "p":
          // Full path
          value = result.path;
          i++;
          break;
        case "P": {
          // Path without starting point
          const sp = result.startingPoint;
          if (result.path === sp) {
            value = "";
          } else if (result.path.startsWith(`${sp}/`)) {
            value = result.path.slice(sp.length + 1);
          } else if (sp === "." && result.path.startsWith("./")) {
            value = result.path.slice(2);
          } else {
            value = result.path;
          }
          i++;
          break;
        }
        case "s":
          // File size in bytes
          value = String(result.size);
          i++;
          break;
        case "d":
          // Depth in directory tree
          value = String(result.depth);
          i++;
          break;
        case "m":
          // Permissions in octal (without leading 0)
          value = (result.mode & 0o777).toString(8);
          i++;
          break;
        case "M":
          // Symbolic permissions
          value = formatMode(result.mode, result.isDirectory);
          i++;
          break;
        case "t": {
          // Modification time in ctime format
          const date = new Date(result.mtime);
          value = formatCtimeDate(date);
          i++;
          break;
        }
        case "T": {
          // Time format: %T@ for epoch, %TY for year, etc.
          if (i + 1 < processed.length) {
            const timeFormat = processed[i + 1];
            const date = new Date(result.mtime);
            value = formatTimeDirective(date, timeFormat);
            i += 2;
          } else {
            value = "%T";
            i++;
          }
          break;
        }
        default:
          // Unknown directive, keep as-is
          output += `%${width !== 0 || precision !== -1 ? `${width}.${precision}` : ""}${directive}`;
          i++;
          continue;
      }

      // Apply width/precision formatting using shared utility
      output += applyWidth(value, width, precision);
    } else {
      output += processed[i];
      i++;
    }
  }

  return output;
}

// formatMode imported from ../format-mode.js

/**
 * Format date in ctime format: "Wed Dec 25 12:34:56 2024"
 */
function formatCtimeDate(date: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec"
  ];

  const day = days[date.getDay()];
  const month = months[date.getMonth()];
  const dayNum = String(date.getDate()).padStart(2, " ");
  const hours = String(date.getHours()).padStart(2, "0");
  const mins = String(date.getMinutes()).padStart(2, "0");
  const secs = String(date.getSeconds()).padStart(2, "0");
  const year = date.getFullYear();

  return `${day} ${month} ${dayNum} ${hours}:${mins}:${secs} ${year}`;
}

/**
 * Format time with %T directive format character
 */
function formatTimeDirective(date: Date, format: string): string {
  switch (format) {
    case "@":
      // Seconds since epoch (with fractional part)
      return String(date.getTime() / 1000);
    case "Y":
      // Year with century
      return String(date.getFullYear());
    case "m":
      // Month (01-12)
      return String(date.getMonth() + 1).padStart(2, "0");
    case "d":
      // Day of month (01-31)
      return String(date.getDate()).padStart(2, "0");
    case "H":
      // Hour (00-23)
      return String(date.getHours()).padStart(2, "0");
    case "M":
      // Minute (00-59)
      return String(date.getMinutes()).padStart(2, "0");
    case "S":
      // Second (00-59)
      return String(date.getSeconds()).padStart(2, "0");
    case "T":
      // Time as HH:MM:SS
      return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
    case "F":
      // Date as YYYY-MM-DD
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    default:
      return `%T${format}`;
  }
}

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "find",
  flags: [
    { flag: "-name", type: "value", valueHint: "pattern" },
    { flag: "-iname", type: "value", valueHint: "pattern" },
    { flag: "-type", type: "value", valueHint: "string" },
    { flag: "-maxdepth", type: "value", valueHint: "number" },
    { flag: "-mindepth", type: "value", valueHint: "number" },
    { flag: "-empty", type: "boolean" },
    { flag: "-print", type: "boolean" },
    { flag: "-print0", type: "boolean" }
  ],
  needsFiles: true
};
