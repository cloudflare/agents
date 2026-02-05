/**
 * Task Management Module
 *
 * Pure functions for managing hierarchical tasks with dependencies.
 * Designed to be stable and independent of server internals.
 *
 * Features:
 * - Hierarchical task decomposition (parent → subtasks)
 * - Dependency tracking (task A depends on task B)
 * - Status management and transitions
 * - Task tree operations
 */

// ============================================================================
// Types
// ============================================================================

export type TaskType = "explore" | "code" | "test" | "review" | "plan" | "fix";

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "blocked"
  | "complete"
  | "failed"
  | "cancelled";

export interface Task {
  id: string;
  parentId?: string;
  type: TaskType;
  title: string;
  description?: string;
  status: TaskStatus;
  dependencies: string[];
  result?: string;
  error?: string;
  assignedTo?: string; // Subagent/DO id
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface TaskGraph {
  tasks: Map<string, Task>;
  rootTasks: Set<string>; // Tasks with no parent
}

export interface TaskTreeNode {
  task: Task;
  children: TaskTreeNode[];
  depth: number;
}

export interface CreateTaskInput {
  id?: string;
  parentId?: string;
  type: TaskType;
  title: string;
  description?: string;
  dependencies?: string[];
  assignedTo?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskValidationError {
  type:
    | "cycle_detected"
    | "missing_dependency"
    | "missing_parent"
    | "max_depth_exceeded"
    | "max_subtasks_exceeded"
    | "max_total_exceeded"
    | "duplicate_id";
  message: string;
  taskId?: string;
  details?: Record<string, unknown>;
}

// ============================================================================
// Configuration
// ============================================================================

export const TASK_CONFIG = {
  maxDepth: 3, // Don't break down more than 3 levels
  maxSubtasks: 10, // Max children per task
  maxTotalTasks: 50, // Prevent runaway decomposition
  defaultType: "code" as TaskType
};

// ============================================================================
// Task Graph Operations
// ============================================================================

/**
 * Create an empty task graph
 */
export function createTaskGraph(): TaskGraph {
  return {
    tasks: new Map(),
    rootTasks: new Set()
  };
}

/**
 * Generate a unique task ID
 */
export function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a new task
 */
export function createTask(input: CreateTaskInput, now?: number): Task {
  return {
    id: input.id || generateTaskId(),
    parentId: input.parentId,
    type: input.type,
    title: input.title,
    description: input.description,
    status: "pending",
    dependencies: input.dependencies || [],
    assignedTo: input.assignedTo,
    createdAt: now ?? Date.now(),
    metadata: input.metadata
  };
}

/**
 * Add a task to the graph
 * Returns validation error if invalid, or the updated graph
 */
export function addTask(
  graph: TaskGraph,
  task: Task
): TaskGraph | TaskValidationError {
  // Check for duplicate ID
  if (graph.tasks.has(task.id)) {
    return {
      type: "duplicate_id",
      message: `Task with id "${task.id}" already exists`,
      taskId: task.id
    };
  }

  // Check parent exists
  if (task.parentId && !graph.tasks.has(task.parentId)) {
    return {
      type: "missing_parent",
      message: `Parent task "${task.parentId}" does not exist`,
      taskId: task.id,
      details: { parentId: task.parentId }
    };
  }

  // Check dependencies exist
  for (const depId of task.dependencies) {
    if (!graph.tasks.has(depId)) {
      return {
        type: "missing_dependency",
        message: `Dependency "${depId}" does not exist`,
        taskId: task.id,
        details: { dependencyId: depId }
      };
    }
  }

  // Check max total tasks
  if (graph.tasks.size >= TASK_CONFIG.maxTotalTasks) {
    return {
      type: "max_total_exceeded",
      message: `Maximum total tasks (${TASK_CONFIG.maxTotalTasks}) exceeded`,
      taskId: task.id
    };
  }

  // Check max depth
  const depth = getTaskDepth(graph, task.parentId);
  if (depth >= TASK_CONFIG.maxDepth) {
    return {
      type: "max_depth_exceeded",
      message: `Maximum depth (${TASK_CONFIG.maxDepth}) exceeded`,
      taskId: task.id,
      details: { depth: depth + 1, maxDepth: TASK_CONFIG.maxDepth }
    };
  }

  // Check max subtasks for parent
  if (task.parentId) {
    const siblingCount = countChildren(graph, task.parentId);
    if (siblingCount >= TASK_CONFIG.maxSubtasks) {
      return {
        type: "max_subtasks_exceeded",
        message: `Maximum subtasks (${TASK_CONFIG.maxSubtasks}) for parent "${task.parentId}" exceeded`,
        taskId: task.id,
        details: { parentId: task.parentId, count: siblingCount }
      };
    }
  }

  // Check for cycles in dependencies
  const cycleCheck = wouldCreateCycle(graph, task);
  if (cycleCheck) {
    return cycleCheck;
  }

  // Add to graph
  const newTasks = new Map(graph.tasks);
  newTasks.set(task.id, task);

  const newRoots = new Set(graph.rootTasks);
  if (!task.parentId) {
    newRoots.add(task.id);
  }

  return { tasks: newTasks, rootTasks: newRoots };
}

/**
 * Get the depth of a task in the hierarchy (0 for root tasks)
 */
export function getTaskDepth(graph: TaskGraph, parentId?: string): number {
  if (!parentId) return 0;
  let depth = 0;
  let currentParent: string | undefined = parentId;
  while (currentParent) {
    depth++;
    const parent = graph.tasks.get(currentParent);
    currentParent = parent?.parentId;
  }
  return depth;
}

/**
 * Count children of a task
 */
export function countChildren(graph: TaskGraph, parentId: string): number {
  let count = 0;
  for (const task of graph.tasks.values()) {
    if (task.parentId === parentId) count++;
  }
  return count;
}

/**
 * Check if adding a task would create a cycle in dependencies
 */
function wouldCreateCycle(
  graph: TaskGraph,
  newTask: Task
): TaskValidationError | null {
  // A cycle would occur if any dependency eventually depends on the new task
  // Since we're adding a new task, we only need to check if any dependency
  // path leads back to our parentId (which would create a cycle through hierarchy)

  const visited = new Set<string>();

  function hasPathTo(fromId: string, toId: string): boolean {
    if (fromId === toId) return true;
    if (visited.has(fromId)) return false;
    visited.add(fromId);

    const task = graph.tasks.get(fromId);
    if (!task) return false;

    for (const depId of task.dependencies) {
      if (hasPathTo(depId, toId)) return true;
    }
    return false;
  }

  // Check each dependency - if it can reach any of our ancestors, we have a cycle
  let ancestor = newTask.parentId;
  while (ancestor) {
    for (const depId of newTask.dependencies) {
      visited.clear();
      if (depId === ancestor || hasPathTo(depId, ancestor)) {
        return {
          type: "cycle_detected",
          message: `Adding task would create a dependency cycle through "${ancestor}"`,
          taskId: newTask.id,
          details: { dependencyId: depId, ancestorId: ancestor }
        };
      }
    }
    const parent = graph.tasks.get(ancestor);
    ancestor = parent?.parentId;
  }

  return null;
}

// ============================================================================
// Task Status Operations
// ============================================================================

/**
 * Start a task (pending → in_progress)
 */
export function startTask(
  graph: TaskGraph,
  taskId: string,
  assignedTo?: string,
  now?: number
): TaskGraph | null {
  const task = graph.tasks.get(taskId);
  if (!task || task.status !== "pending") return null;

  // Check dependencies are satisfied
  if (!areDependenciesSatisfied(graph, task)) return null;

  const updated: Task = {
    ...task,
    status: "in_progress",
    startedAt: now ?? Date.now(),
    assignedTo: assignedTo ?? task.assignedTo
  };

  const newTasks = new Map(graph.tasks);
  newTasks.set(taskId, updated);
  return { tasks: newTasks, rootTasks: graph.rootTasks };
}

/**
 * Complete a task with optional result
 */
export function completeTask(
  graph: TaskGraph,
  taskId: string,
  result?: string,
  now?: number
): TaskGraph | null {
  const task = graph.tasks.get(taskId);
  if (!task || !isActiveStatus(task.status)) return null;

  const updated: Task = {
    ...task,
    status: "complete",
    result,
    completedAt: now ?? Date.now()
  };

  const newTasks = new Map(graph.tasks);
  newTasks.set(taskId, updated);

  // Update blocked tasks that depended on this one
  return updateBlockedTasks({ tasks: newTasks, rootTasks: graph.rootTasks });
}

/**
 * Fail a task with error
 */
export function failTask(
  graph: TaskGraph,
  taskId: string,
  error: string,
  now?: number
): TaskGraph | null {
  const task = graph.tasks.get(taskId);
  if (!task || !isActiveStatus(task.status)) return null;

  const updated: Task = {
    ...task,
    status: "failed",
    error,
    completedAt: now ?? Date.now()
  };

  const newTasks = new Map(graph.tasks);
  newTasks.set(taskId, updated);

  // Update dependent tasks that might now be blocked
  return updateBlockedTasks({ tasks: newTasks, rootTasks: graph.rootTasks });
}

/**
 * Cancel a task
 */
export function cancelTask(
  graph: TaskGraph,
  taskId: string,
  now?: number
): TaskGraph | null {
  const task = graph.tasks.get(taskId);
  if (!task || isTerminalStatus(task.status)) return null;

  const updated: Task = {
    ...task,
    status: "cancelled",
    completedAt: now ?? Date.now()
  };

  const newTasks = new Map(graph.tasks);
  newTasks.set(taskId, updated);

  // Update dependent tasks that might now be blocked
  return updateBlockedTasks({ tasks: newTasks, rootTasks: graph.rootTasks });
}

/**
 * Block a task (typically when a dependency fails)
 */
export function blockTask(graph: TaskGraph, taskId: string): TaskGraph | null {
  const task = graph.tasks.get(taskId);
  if (!task || task.status !== "pending") return null;

  const updated: Task = {
    ...task,
    status: "blocked"
  };

  const newTasks = new Map(graph.tasks);
  newTasks.set(taskId, updated);
  return { tasks: newTasks, rootTasks: graph.rootTasks };
}

// ============================================================================
// Dependency Resolution
// ============================================================================

/**
 * Check if all dependencies of a task are complete
 */
export function areDependenciesSatisfied(
  graph: TaskGraph,
  task: Task
): boolean {
  for (const depId of task.dependencies) {
    const dep = graph.tasks.get(depId);
    if (!dep || dep.status !== "complete") return false;
  }
  return true;
}

/**
 * Get all tasks that are ready to be worked on (pending with all deps satisfied)
 */
export function getReadyTasks(graph: TaskGraph): Task[] {
  const ready: Task[] = [];

  for (const task of graph.tasks.values()) {
    if (task.status === "pending" && areDependenciesSatisfied(graph, task)) {
      ready.push(task);
    }
  }

  // Sort by creation time (oldest first)
  return ready.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Get tasks currently in progress
 */
export function getActiveTasks(graph: TaskGraph): Task[] {
  const active: Task[] = [];

  for (const task of graph.tasks.values()) {
    if (task.status === "in_progress") {
      active.push(task);
    }
  }

  return active;
}

/**
 * Get tasks that are blocked
 */
export function getBlockedTasks(graph: TaskGraph): Task[] {
  const blocked: Task[] = [];

  for (const task of graph.tasks.values()) {
    if (task.status === "blocked") {
      blocked.push(task);
    }
  }

  return blocked;
}

/**
 * Update blocked tasks - unblock if dependencies now satisfied
 */
function updateBlockedTasks(graph: TaskGraph): TaskGraph {
  let changed = true;
  const newTasks = new Map(graph.tasks);

  // Keep iterating until no more changes
  while (changed) {
    changed = false;

    for (const [id, task] of newTasks) {
      if (task.status === "blocked") {
        const satisfied = task.dependencies.every((depId) => {
          const dep = newTasks.get(depId);
          return dep && dep.status === "complete";
        });

        if (satisfied) {
          newTasks.set(id, { ...task, status: "pending" });
          changed = true;
        }
      }

      // Block pending tasks if a dependency failed
      if (task.status === "pending") {
        const hasFailed = task.dependencies.some((depId) => {
          const dep = newTasks.get(depId);
          return dep && (dep.status === "failed" || dep.status === "cancelled");
        });

        if (hasFailed) {
          newTasks.set(id, { ...task, status: "blocked" });
          changed = true;
        }
      }
    }
  }

  return { tasks: newTasks, rootTasks: graph.rootTasks };
}

// ============================================================================
// Task Tree Operations
// ============================================================================

/**
 * Get hierarchical tree representation
 */
export function getTaskTree(graph: TaskGraph): TaskTreeNode[] {
  const roots: TaskTreeNode[] = [];

  for (const rootId of graph.rootTasks) {
    const task = graph.tasks.get(rootId);
    if (task) {
      roots.push(buildTreeNode(graph, task, 0));
    }
  }

  return roots;
}

function buildTreeNode(
  graph: TaskGraph,
  task: Task,
  depth: number
): TaskTreeNode {
  const children: TaskTreeNode[] = [];

  for (const childTask of graph.tasks.values()) {
    if (childTask.parentId === task.id) {
      children.push(buildTreeNode(graph, childTask, depth + 1));
    }
  }

  // Sort children by creation time
  children.sort((a, b) => a.task.createdAt - b.task.createdAt);

  return { task, children, depth };
}

/**
 * Get all descendants of a task
 */
export function getDescendants(graph: TaskGraph, taskId: string): Task[] {
  const descendants: Task[] = [];
  const queue = [taskId];

  while (queue.length > 0) {
    const currentId = queue.shift()!;

    for (const task of graph.tasks.values()) {
      if (task.parentId === currentId) {
        descendants.push(task);
        queue.push(task.id);
      }
    }
  }

  return descendants;
}

/**
 * Get all ancestors of a task (parent chain)
 */
export function getAncestors(graph: TaskGraph, taskId: string): Task[] {
  const ancestors: Task[] = [];
  let current = graph.tasks.get(taskId);

  while (current?.parentId) {
    const parent = graph.tasks.get(current.parentId);
    if (parent) {
      ancestors.push(parent);
      current = parent;
    } else {
      break;
    }
  }

  return ancestors;
}

// ============================================================================
// Status Helpers
// ============================================================================

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === "complete" || status === "failed" || status === "cancelled";
}

export function isActiveStatus(status: TaskStatus): boolean {
  return (
    status === "pending" || status === "in_progress" || status === "blocked"
  );
}

// ============================================================================
// Progress Tracking
// ============================================================================

export interface TaskProgress {
  total: number;
  pending: number;
  inProgress: number;
  blocked: number;
  complete: number;
  failed: number;
  cancelled: number;
  percentComplete: number;
}

/**
 * Get progress statistics for the task graph
 */
export function getProgress(graph: TaskGraph): TaskProgress {
  const stats = {
    total: graph.tasks.size,
    pending: 0,
    inProgress: 0,
    blocked: 0,
    complete: 0,
    failed: 0,
    cancelled: 0,
    percentComplete: 0
  };

  for (const task of graph.tasks.values()) {
    switch (task.status) {
      case "pending":
        stats.pending++;
        break;
      case "in_progress":
        stats.inProgress++;
        break;
      case "blocked":
        stats.blocked++;
        break;
      case "complete":
        stats.complete++;
        break;
      case "failed":
        stats.failed++;
        break;
      case "cancelled":
        stats.cancelled++;
        break;
    }
  }

  if (stats.total > 0) {
    stats.percentComplete = Math.round((stats.complete / stats.total) * 100);
  }

  return stats;
}

/**
 * Get progress for a subtree
 */
export function getSubtreeProgress(
  graph: TaskGraph,
  rootTaskId: string
): TaskProgress {
  const descendants = getDescendants(graph, rootTaskId);
  const root = graph.tasks.get(rootTaskId);

  if (!root) {
    return {
      total: 0,
      pending: 0,
      inProgress: 0,
      blocked: 0,
      complete: 0,
      failed: 0,
      cancelled: 0,
      percentComplete: 0
    };
  }

  const allTasks = [root, ...descendants];
  const stats = {
    total: allTasks.length,
    pending: 0,
    inProgress: 0,
    blocked: 0,
    complete: 0,
    failed: 0,
    cancelled: 0,
    percentComplete: 0
  };

  for (const task of allTasks) {
    switch (task.status) {
      case "pending":
        stats.pending++;
        break;
      case "in_progress":
        stats.inProgress++;
        break;
      case "blocked":
        stats.blocked++;
        break;
      case "complete":
        stats.complete++;
        break;
      case "failed":
        stats.failed++;
        break;
      case "cancelled":
        stats.cancelled++;
        break;
    }
  }

  if (stats.total > 0) {
    stats.percentComplete = Math.round((stats.complete / stats.total) * 100);
  }

  return stats;
}

// ============================================================================
// Serialization (for SQLite storage)
// ============================================================================

/**
 * Convert task graph to array for storage
 */
export function serializeGraph(graph: TaskGraph): Task[] {
  return Array.from(graph.tasks.values());
}

/**
 * Reconstruct task graph from array
 */
export function deserializeGraph(tasks: Task[]): TaskGraph {
  const graph: TaskGraph = {
    tasks: new Map(),
    rootTasks: new Set()
  };

  for (const task of tasks) {
    graph.tasks.set(task.id, task);
    if (!task.parentId) {
      graph.rootTasks.add(task.id);
    }
  }

  return graph;
}

// ============================================================================
// SQL Fragments for Integration
// ============================================================================

export const TASK_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  dependencies TEXT NOT NULL DEFAULT '[]',
  result TEXT,
  error TEXT,
  assigned_to TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  metadata TEXT
)
`;

export const TASK_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);
`;

/**
 * Convert Task to SQLite row values
 */
export function taskToRow(task: Task): {
  id: string;
  parent_id: string | null;
  type: string;
  title: string;
  description: string | null;
  status: string;
  dependencies: string;
  result: string | null;
  error: string | null;
  assigned_to: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  metadata: string | null;
} {
  return {
    id: task.id,
    parent_id: task.parentId ?? null,
    type: task.type,
    title: task.title,
    description: task.description ?? null,
    status: task.status,
    dependencies: JSON.stringify(task.dependencies),
    result: task.result ?? null,
    error: task.error ?? null,
    assigned_to: task.assignedTo ?? null,
    created_at: task.createdAt,
    started_at: task.startedAt ?? null,
    completed_at: task.completedAt ?? null,
    metadata: task.metadata ? JSON.stringify(task.metadata) : null
  };
}

/**
 * Convert SQLite row to Task
 */
export function rowToTask(row: {
  id: string;
  parent_id: string | null;
  type: string;
  title: string;
  description: string | null;
  status: string;
  dependencies: string;
  result: string | null;
  error: string | null;
  assigned_to: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  metadata: string | null;
}): Task {
  return {
    id: row.id,
    parentId: row.parent_id ?? undefined,
    type: row.type as TaskType,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status as TaskStatus,
    dependencies: JSON.parse(row.dependencies) as string[],
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    assignedTo: row.assigned_to ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    metadata: row.metadata
      ? (JSON.parse(row.metadata) as Record<string, unknown>)
      : undefined
  };
}
