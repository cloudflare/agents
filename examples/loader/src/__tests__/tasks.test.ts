/**
 * Task Management Unit Tests
 *
 * Fast unit tests for the tasks.ts module's pure functions.
 * These tests run entirely in-memory with no external dependencies.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  // Types
  type Task,
  type TaskGraph,
  type CreateTaskInput,
  type TaskValidationError,

  // Config
  TASK_CONFIG,

  // Graph operations
  createTaskGraph,
  generateTaskId,
  createTask,
  addTask,
  getTaskDepth,
  countChildren,

  // Status operations
  startTask,
  completeTask,
  failTask,
  cancelTask,
  blockTask,

  // Dependency resolution
  areDependenciesSatisfied,
  getReadyTasks,
  getActiveTasks,
  getBlockedTasks,

  // Tree operations
  getTaskTree,
  getDescendants,
  getAncestors,

  // Status helpers
  isTerminalStatus,
  isActiveStatus,

  // Progress tracking
  getProgress,
  getSubtreeProgress,

  // Serialization
  serializeGraph,
  deserializeGraph,
  taskToRow,
  rowToTask
} from "../tasks";

// ============================================================================
// Test Helpers
// ============================================================================

function createTestTask(
  graph: TaskGraph,
  input: Partial<CreateTaskInput> & { title: string }
): { graph: TaskGraph; task: Task } {
  const task = createTask({
    type: input.type ?? "code",
    title: input.title,
    description: input.description,
    parentId: input.parentId,
    dependencies: input.dependencies ?? [],
    assignedTo: input.assignedTo,
    metadata: input.metadata,
    id: input.id
  });

  const result = addTask(graph, task);
  if ("type" in result && typeof result.type === "string") {
    throw new Error(`Failed to add task: ${result.message}`);
  }
  return { graph: result as TaskGraph, task };
}

// ============================================================================
// Task Creation Tests
// ============================================================================

describe("Task Creation", () => {
  it("createTaskGraph returns empty graph", () => {
    const graph = createTaskGraph();
    expect(graph.tasks.size).toBe(0);
    expect(graph.rootTasks.size).toBe(0);
  });

  it("generateTaskId creates unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateTaskId());
    }
    expect(ids.size).toBe(100);
  });

  it("createTask creates task with defaults", () => {
    const task = createTask({
      type: "code",
      title: "Test task"
    });

    expect(task.id).toBeDefined();
    expect(task.type).toBe("code");
    expect(task.title).toBe("Test task");
    expect(task.status).toBe("pending");
    expect(task.dependencies).toEqual([]);
    expect(task.createdAt).toBeGreaterThan(0);
  });

  it("createTask uses provided values", () => {
    const now = Date.now();
    const task = createTask(
      {
        id: "custom-id",
        type: "test",
        title: "Custom task",
        description: "A description",
        parentId: "parent-1",
        dependencies: ["dep-1", "dep-2"],
        assignedTo: "agent-1",
        metadata: { priority: "high" }
      },
      now
    );

    expect(task.id).toBe("custom-id");
    expect(task.type).toBe("test");
    expect(task.description).toBe("A description");
    expect(task.parentId).toBe("parent-1");
    expect(task.dependencies).toEqual(["dep-1", "dep-2"]);
    expect(task.assignedTo).toBe("agent-1");
    expect(task.metadata).toEqual({ priority: "high" });
    expect(task.createdAt).toBe(now);
  });
});

// ============================================================================
// Task Graph Operations Tests
// ============================================================================

describe("Task Graph Operations", () => {
  let graph: TaskGraph;

  beforeEach(() => {
    graph = createTaskGraph();
  });

  describe("addTask", () => {
    it("adds root task successfully", () => {
      const task = createTask({ type: "code", title: "Root task" });
      const result = addTask(graph, task);

      expect("tasks" in result).toBe(true);
      const newGraph = result as TaskGraph;
      expect(newGraph.tasks.has(task.id)).toBe(true);
      expect(newGraph.rootTasks.has(task.id)).toBe(true);
    });

    it("adds child task successfully", () => {
      const { graph: g1 } = createTestTask(graph, {
        id: "parent",
        title: "Parent"
      });
      const { graph: g2 } = createTestTask(g1, {
        id: "child",
        title: "Child",
        parentId: "parent"
      });

      expect(g2.tasks.has("child")).toBe(true);
      expect(g2.rootTasks.has("child")).toBe(false);
    });

    it("rejects duplicate ID", () => {
      const { graph: g1 } = createTestTask(graph, {
        id: "task-1",
        title: "First"
      });
      const duplicate = createTask({
        id: "task-1",
        type: "code",
        title: "Dup"
      });
      const result = addTask(g1, duplicate);

      expect("type" in result).toBe(true);
      expect((result as TaskValidationError).type).toBe("duplicate_id");
    });

    it("rejects task with missing parent", () => {
      const task = createTask({
        type: "code",
        title: "Orphan",
        parentId: "nonexistent"
      });
      const result = addTask(graph, task);

      expect("type" in result).toBe(true);
      expect((result as TaskValidationError).type).toBe("missing_parent");
    });

    it("rejects task with missing dependency", () => {
      const task = createTask({
        type: "code",
        title: "Task",
        dependencies: ["nonexistent"]
      });
      const result = addTask(graph, task);

      expect("type" in result).toBe(true);
      expect((result as TaskValidationError).type).toBe("missing_dependency");
    });

    it("rejects when max total tasks exceeded", () => {
      let g = graph;
      // Add max tasks
      for (let i = 0; i < TASK_CONFIG.maxTotalTasks; i++) {
        const { graph: updated } = createTestTask(g, { title: `Task ${i}` });
        g = updated;
      }

      // Try to add one more
      const task = createTask({ type: "code", title: "One too many" });
      const result = addTask(g, task);

      expect("type" in result).toBe(true);
      expect((result as TaskValidationError).type).toBe("max_total_exceeded");
    });

    it("rejects when max depth exceeded", () => {
      let g = graph;
      let parentId: string | undefined;

      // Build chain to max depth
      for (let i = 0; i < TASK_CONFIG.maxDepth; i++) {
        const { graph: updated, task } = createTestTask(g, {
          title: `Level ${i}`,
          parentId
        });
        g = updated;
        parentId = task.id;
      }

      // Try to add one more level
      const task = createTask({
        type: "code",
        title: "Too deep",
        parentId
      });
      const result = addTask(g, task);

      expect("type" in result).toBe(true);
      expect((result as TaskValidationError).type).toBe("max_depth_exceeded");
    });

    it("rejects when max subtasks exceeded", () => {
      const { graph: g1, task: parent } = createTestTask(graph, {
        title: "Parent"
      });

      let g = g1;
      // Add max subtasks
      for (let i = 0; i < TASK_CONFIG.maxSubtasks; i++) {
        const { graph: updated } = createTestTask(g, {
          title: `Child ${i}`,
          parentId: parent.id
        });
        g = updated;
      }

      // Try to add one more
      const task = createTask({
        type: "code",
        title: "One too many children",
        parentId: parent.id
      });
      const result = addTask(g, task);

      expect("type" in result).toBe(true);
      expect((result as TaskValidationError).type).toBe(
        "max_subtasks_exceeded"
      );
    });
  });

  describe("getTaskDepth", () => {
    it("returns 0 for no parent", () => {
      expect(getTaskDepth(graph, undefined)).toBe(0);
    });

    it("returns correct depth for nested tasks", () => {
      const { graph: g1, task: _t1 } = createTestTask(graph, { title: "L0" });
      const { graph: g2, task: _t2 } = createTestTask(g1, {
        title: "L1",
        parentId: _t1.id
      });
      const { graph: g3, task: _t3 } = createTestTask(g2, {
        title: "L2",
        parentId: _t2.id
      });

      expect(getTaskDepth(g3, _t1.id)).toBe(1);
      expect(getTaskDepth(g3, _t2.id)).toBe(2);
      expect(getTaskDepth(g3, _t3.id)).toBe(3);
    });
  });

  describe("countChildren", () => {
    it("returns 0 for task with no children", () => {
      const { graph: g1, task } = createTestTask(graph, { title: "Lonely" });
      expect(countChildren(g1, task.id)).toBe(0);
    });

    it("returns correct count", () => {
      const { graph: g1, task: parent } = createTestTask(graph, {
        title: "Parent"
      });
      const { graph: g2 } = createTestTask(g1, {
        title: "Child 1",
        parentId: parent.id
      });
      const { graph: g3 } = createTestTask(g2, {
        title: "Child 2",
        parentId: parent.id
      });

      expect(countChildren(g3, parent.id)).toBe(2);
    });
  });
});

// ============================================================================
// Cycle Detection Tests
// ============================================================================

describe("Cycle Detection", () => {
  let graph: TaskGraph;

  beforeEach(() => {
    graph = createTaskGraph();
  });

  it("allows valid dependency chains", () => {
    const { graph: g1, task: t1 } = createTestTask(graph, {
      id: "a",
      title: "Task A"
    });
    const { graph: g2, task: t2 } = createTestTask(g1, {
      id: "b",
      title: "Task B",
      dependencies: ["a"]
    });
    const { graph: g3 } = createTestTask(g2, {
      id: "c",
      title: "Task C",
      dependencies: ["b"]
    });

    expect(g3.tasks.size).toBe(3);
  });

  // Note: Full cycle detection is complex; current implementation
  // prevents cycles through parent-dependency conflicts
});

// ============================================================================
// Task Status Operations Tests
// ============================================================================

describe("Task Status Operations", () => {
  let graph: TaskGraph;

  beforeEach(() => {
    graph = createTaskGraph();
  });

  describe("startTask", () => {
    it("transitions pending to in_progress", () => {
      const { graph: g1, task } = createTestTask(graph, { title: "Task" });
      const now = Date.now();
      const result = startTask(g1, task.id, "agent-1", now);

      expect(result).not.toBeNull();
      const updated = result!.tasks.get(task.id)!;
      expect(updated.status).toBe("in_progress");
      expect(updated.startedAt).toBe(now);
      expect(updated.assignedTo).toBe("agent-1");
    });

    it("returns null for non-pending task", () => {
      const { graph: g1, task } = createTestTask(graph, { title: "Task" });
      const g2 = startTask(g1, task.id)!;
      const result = startTask(g2, task.id);

      expect(result).toBeNull();
    });

    it("returns null if dependencies not satisfied", () => {
      const { graph: g1 } = createTestTask(graph, {
        id: "dep",
        title: "Dependency"
      });
      const { graph: g2, task } = createTestTask(g1, {
        title: "Dependent",
        dependencies: ["dep"]
      });

      const result = startTask(g2, task.id);
      expect(result).toBeNull();
    });

    it("allows start when dependencies complete", () => {
      const { graph: g1, task: dep } = createTestTask(graph, {
        id: "dep",
        title: "Dependency"
      });
      const { graph: g2, task } = createTestTask(g1, {
        title: "Dependent",
        dependencies: ["dep"]
      });

      // Complete the dependency
      const g3 = startTask(g2, dep.id)!;
      const g4 = completeTask(g3, dep.id)!;

      // Now should be able to start dependent
      const result = startTask(g4, task.id);
      expect(result).not.toBeNull();
      expect(result!.tasks.get(task.id)!.status).toBe("in_progress");
    });
  });

  describe("completeTask", () => {
    it("completes in_progress task", () => {
      const { graph: g1, task } = createTestTask(graph, { title: "Task" });
      const g2 = startTask(g1, task.id)!;
      const now = Date.now();
      const result = completeTask(g2, task.id, "Done!", now);

      expect(result).not.toBeNull();
      const updated = result!.tasks.get(task.id)!;
      expect(updated.status).toBe("complete");
      expect(updated.result).toBe("Done!");
      expect(updated.completedAt).toBe(now);
    });

    it("returns null for terminal task", () => {
      const { graph: g1, task } = createTestTask(graph, { title: "Task" });
      const g2 = startTask(g1, task.id)!;
      const g3 = completeTask(g2, task.id)!;
      const result = completeTask(g3, task.id);

      expect(result).toBeNull();
    });

    it("unblocks dependent tasks", () => {
      const { graph: g1, task: dep } = createTestTask(graph, {
        id: "dep",
        title: "Dependency"
      });
      const { graph: g2, task } = createTestTask(g1, {
        title: "Dependent",
        dependencies: ["dep"]
      });

      // Start and complete dependency
      const g3 = startTask(g2, dep.id)!;
      const g4 = completeTask(g3, dep.id)!;

      // Dependent should now be pending (ready to start)
      const dependent = g4.tasks.get(task.id)!;
      expect(dependent.status).toBe("pending");
    });
  });

  describe("failTask", () => {
    it("fails in_progress task", () => {
      const { graph: g1, task } = createTestTask(graph, { title: "Task" });
      const g2 = startTask(g1, task.id)!;
      const result = failTask(g2, task.id, "Something went wrong");

      expect(result).not.toBeNull();
      const updated = result!.tasks.get(task.id)!;
      expect(updated.status).toBe("failed");
      expect(updated.error).toBe("Something went wrong");
    });

    it("returns null for terminal task", () => {
      const { graph: g1, task } = createTestTask(graph, { title: "Task" });
      const g2 = startTask(g1, task.id)!;
      const g3 = completeTask(g2, task.id)!;
      const result = failTask(g3, task.id, "Too late");

      expect(result).toBeNull();
    });
  });

  describe("cancelTask", () => {
    it("cancels pending task", () => {
      const { graph: g1, task } = createTestTask(graph, { title: "Task" });
      const result = cancelTask(g1, task.id);

      expect(result).not.toBeNull();
      expect(result!.tasks.get(task.id)!.status).toBe("cancelled");
    });

    it("cancels in_progress task", () => {
      const { graph: g1, task } = createTestTask(graph, { title: "Task" });
      const g2 = startTask(g1, task.id)!;
      const result = cancelTask(g2, task.id);

      expect(result).not.toBeNull();
      expect(result!.tasks.get(task.id)!.status).toBe("cancelled");
    });

    it("returns null for completed task", () => {
      const { graph: g1, task } = createTestTask(graph, { title: "Task" });
      const g2 = startTask(g1, task.id)!;
      const g3 = completeTask(g2, task.id)!;
      const result = cancelTask(g3, task.id);

      expect(result).toBeNull();
    });
  });

  describe("blockTask", () => {
    it("blocks pending task", () => {
      const { graph: g1, task } = createTestTask(graph, { title: "Task" });
      const result = blockTask(g1, task.id);

      expect(result).not.toBeNull();
      expect(result!.tasks.get(task.id)!.status).toBe("blocked");
    });

    it("returns null for non-pending task", () => {
      const { graph: g1, task } = createTestTask(graph, { title: "Task" });
      const g2 = startTask(g1, task.id)!;
      const result = blockTask(g2, task.id);

      expect(result).toBeNull();
    });
  });
});

// ============================================================================
// Dependency Resolution Tests
// ============================================================================

describe("Dependency Resolution", () => {
  let graph: TaskGraph;

  beforeEach(() => {
    graph = createTaskGraph();
  });

  describe("areDependenciesSatisfied", () => {
    it("returns true for task with no dependencies", () => {
      const { graph: g1, task } = createTestTask(graph, { title: "Task" });
      expect(areDependenciesSatisfied(g1, task)).toBe(true);
    });

    it("returns false when dependency pending", () => {
      const { graph: g1 } = createTestTask(graph, {
        id: "dep",
        title: "Dep"
      });
      const { graph: g2, task } = createTestTask(g1, {
        title: "Task",
        dependencies: ["dep"]
      });

      expect(areDependenciesSatisfied(g2, task)).toBe(false);
    });

    it("returns false when dependency in_progress", () => {
      const { graph: g1, task: dep } = createTestTask(graph, {
        id: "dep",
        title: "Dep"
      });
      const { graph: g2, task } = createTestTask(g1, {
        title: "Task",
        dependencies: ["dep"]
      });
      const g3 = startTask(g2, dep.id)!;

      expect(areDependenciesSatisfied(g3, g3.tasks.get(task.id)!)).toBe(false);
    });

    it("returns true when all dependencies complete", () => {
      const { graph: g1, task: dep1 } = createTestTask(graph, {
        id: "dep1",
        title: "Dep 1"
      });
      const { graph: g2, task: dep2 } = createTestTask(g1, {
        id: "dep2",
        title: "Dep 2"
      });
      const { graph: g3, task } = createTestTask(g2, {
        title: "Task",
        dependencies: ["dep1", "dep2"]
      });

      const g4 = startTask(g3, dep1.id)!;
      const g5 = completeTask(g4, dep1.id)!;
      const g6 = startTask(g5, dep2.id)!;
      const g7 = completeTask(g6, dep2.id)!;

      expect(areDependenciesSatisfied(g7, g7.tasks.get(task.id)!)).toBe(true);
    });
  });

  describe("getReadyTasks", () => {
    it("returns all tasks when no dependencies", () => {
      const { graph: g1 } = createTestTask(graph, { title: "Task 1" });
      const { graph: g2 } = createTestTask(g1, { title: "Task 2" });
      const { graph: g3 } = createTestTask(g2, { title: "Task 3" });

      const ready = getReadyTasks(g3);
      expect(ready.length).toBe(3);
    });

    it("excludes tasks with unsatisfied dependencies", () => {
      const { graph: g1, task: dep } = createTestTask(graph, {
        id: "dep",
        title: "Dep"
      });
      const { graph: g2 } = createTestTask(g1, {
        title: "Dependent",
        dependencies: ["dep"]
      });

      const ready = getReadyTasks(g2);
      expect(ready.length).toBe(1);
      expect(ready[0].id).toBe(dep.id);
    });

    it("excludes in_progress tasks", () => {
      const { graph: g1, task } = createTestTask(graph, { title: "Task" });
      const g2 = startTask(g1, task.id)!;

      const ready = getReadyTasks(g2);
      expect(ready.length).toBe(0);
    });

    it("sorts by creation time", () => {
      const now = Date.now();
      const t1 = createTask({ type: "code", title: "First" }, now);
      const t2 = createTask({ type: "code", title: "Second" }, now + 100);
      const t3 = createTask({ type: "code", title: "Third" }, now + 50);

      let g = addTask(graph, t1) as TaskGraph;
      g = addTask(g, t2) as TaskGraph;
      g = addTask(g, t3) as TaskGraph;

      const ready = getReadyTasks(g);
      expect(ready[0].title).toBe("First");
      expect(ready[1].title).toBe("Third");
      expect(ready[2].title).toBe("Second");
    });
  });

  describe("getActiveTasks", () => {
    it("returns only in_progress tasks", () => {
      const { graph: g1 } = createTestTask(graph, { id: "t1", title: "T1" });
      const { graph: g2 } = createTestTask(g1, { id: "t2", title: "T2" });
      const g3 = startTask(g2, "t1")!;

      const active = getActiveTasks(g3);
      expect(active.length).toBe(1);
      expect(active[0].id).toBe("t1");
    });
  });

  describe("getBlockedTasks", () => {
    it("returns blocked tasks", () => {
      const { graph: g1 } = createTestTask(graph, { id: "t1", title: "T1" });
      const g2 = blockTask(g1, "t1")!;

      const blocked = getBlockedTasks(g2);
      expect(blocked.length).toBe(1);
      expect(blocked[0].id).toBe("t1");
    });
  });
});

// ============================================================================
// Task Tree Operations Tests
// ============================================================================

describe("Task Tree Operations", () => {
  let graph: TaskGraph;

  beforeEach(() => {
    graph = createTaskGraph();
  });

  describe("getTaskTree", () => {
    it("returns empty array for empty graph", () => {
      const tree = getTaskTree(graph);
      expect(tree).toEqual([]);
    });

    it("returns flat list for tasks with no hierarchy", () => {
      const { graph: g1 } = createTestTask(graph, { title: "Task 1" });
      const { graph: g2 } = createTestTask(g1, { title: "Task 2" });

      const tree = getTaskTree(g2);
      expect(tree.length).toBe(2);
      expect(tree[0].children).toEqual([]);
      expect(tree[1].children).toEqual([]);
    });

    it("builds correct hierarchy", () => {
      const { graph: g1, task: parent } = createTestTask(graph, {
        title: "Parent"
      });
      const { graph: g2, task: child1 } = createTestTask(g1, {
        title: "Child 1",
        parentId: parent.id
      });
      const { graph: g3 } = createTestTask(g2, {
        title: "Child 2",
        parentId: parent.id
      });
      const { graph: g4 } = createTestTask(g3, {
        title: "Grandchild",
        parentId: child1.id
      });

      const tree = getTaskTree(g4);
      expect(tree.length).toBe(1);
      expect(tree[0].task.title).toBe("Parent");
      expect(tree[0].depth).toBe(0);
      expect(tree[0].children.length).toBe(2);
      expect(tree[0].children[0].depth).toBe(1);
      expect(tree[0].children[0].children.length).toBe(1);
      expect(tree[0].children[0].children[0].depth).toBe(2);
    });
  });

  describe("getDescendants", () => {
    it("returns empty array for task with no children", () => {
      const { graph: g1, task } = createTestTask(graph, { title: "Lonely" });
      expect(getDescendants(g1, task.id)).toEqual([]);
    });

    it("returns all descendants", () => {
      const { graph: g1, task: root } = createTestTask(graph, {
        id: "root",
        title: "Root"
      });
      const { graph: g2, task: c1 } = createTestTask(g1, {
        id: "c1",
        title: "Child 1",
        parentId: "root"
      });
      const { graph: g3 } = createTestTask(g2, {
        id: "c2",
        title: "Child 2",
        parentId: "root"
      });
      const { graph: g4 } = createTestTask(g3, {
        id: "gc1",
        title: "Grandchild",
        parentId: "c1"
      });

      const descendants = getDescendants(g4, root.id);
      expect(descendants.length).toBe(3);
      expect(descendants.map((d) => d.id).sort()).toEqual(["c1", "c2", "gc1"]);
    });
  });

  describe("getAncestors", () => {
    it("returns empty array for root task", () => {
      const { graph: g1, task } = createTestTask(graph, { title: "Root" });
      expect(getAncestors(g1, task.id)).toEqual([]);
    });

    it("returns parent chain", () => {
      const { graph: g1 } = createTestTask(graph, {
        id: "root",
        title: "Root"
      });
      const { graph: g2 } = createTestTask(g1, {
        id: "child",
        title: "Child",
        parentId: "root"
      });
      const { graph: g3, task: grandchild } = createTestTask(g2, {
        id: "grandchild",
        title: "Grandchild",
        parentId: "child"
      });

      const ancestors = getAncestors(g3, grandchild.id);
      expect(ancestors.length).toBe(2);
      expect(ancestors[0].id).toBe("child");
      expect(ancestors[1].id).toBe("root");
    });
  });
});

// ============================================================================
// Status Helpers Tests
// ============================================================================

describe("Status Helpers", () => {
  describe("isTerminalStatus", () => {
    it("returns true for complete", () => {
      expect(isTerminalStatus("complete")).toBe(true);
    });

    it("returns true for failed", () => {
      expect(isTerminalStatus("failed")).toBe(true);
    });

    it("returns true for cancelled", () => {
      expect(isTerminalStatus("cancelled")).toBe(true);
    });

    it("returns false for pending", () => {
      expect(isTerminalStatus("pending")).toBe(false);
    });

    it("returns false for in_progress", () => {
      expect(isTerminalStatus("in_progress")).toBe(false);
    });

    it("returns false for blocked", () => {
      expect(isTerminalStatus("blocked")).toBe(false);
    });
  });

  describe("isActiveStatus", () => {
    it("returns true for pending", () => {
      expect(isActiveStatus("pending")).toBe(true);
    });

    it("returns true for in_progress", () => {
      expect(isActiveStatus("in_progress")).toBe(true);
    });

    it("returns true for blocked", () => {
      expect(isActiveStatus("blocked")).toBe(true);
    });

    it("returns false for complete", () => {
      expect(isActiveStatus("complete")).toBe(false);
    });

    it("returns false for failed", () => {
      expect(isActiveStatus("failed")).toBe(false);
    });

    it("returns false for cancelled", () => {
      expect(isActiveStatus("cancelled")).toBe(false);
    });
  });
});

// ============================================================================
// Progress Tracking Tests
// ============================================================================

describe("Progress Tracking", () => {
  let graph: TaskGraph;

  beforeEach(() => {
    graph = createTaskGraph();
  });

  describe("getProgress", () => {
    it("returns zeros for empty graph", () => {
      const progress = getProgress(graph);
      expect(progress.total).toBe(0);
      expect(progress.percentComplete).toBe(0);
    });

    it("calculates correct counts", () => {
      // Add 5 tasks
      const { graph: g1 } = createTestTask(graph, { id: "t1", title: "T1" });
      const { graph: g2 } = createTestTask(g1, { id: "t2", title: "T2" });
      const { graph: g3 } = createTestTask(g2, { id: "t3", title: "T3" });
      const { graph: g4 } = createTestTask(g3, { id: "t4", title: "T4" });
      const { graph: g5 } = createTestTask(g4, { id: "t5", title: "T5" });

      // t1: in_progress
      const g6 = startTask(g5, "t1")!;
      // t2: complete
      const g7 = startTask(g6, "t2")!;
      const g8 = completeTask(g7, "t2")!;
      // t3: failed
      const g9 = startTask(g8, "t3")!;
      const g10 = failTask(g9, "t3", "error")!;
      // t4: cancelled
      const g11 = cancelTask(g10, "t4")!;
      // t5: pending (unchanged)

      const progress = getProgress(g11);
      expect(progress.total).toBe(5);
      expect(progress.pending).toBe(1);
      expect(progress.inProgress).toBe(1);
      expect(progress.complete).toBe(1);
      expect(progress.failed).toBe(1);
      expect(progress.cancelled).toBe(1);
      expect(progress.percentComplete).toBe(20); // 1/5 = 20%
    });
  });

  describe("getSubtreeProgress", () => {
    it("returns zeros for nonexistent task", () => {
      const progress = getSubtreeProgress(graph, "nonexistent");
      expect(progress.total).toBe(0);
    });

    it("calculates progress for subtree only", () => {
      // Root with 2 children, one child has grandchild
      const { graph: g1 } = createTestTask(graph, {
        id: "root",
        title: "Root"
      });
      const { graph: g2 } = createTestTask(g1, {
        id: "c1",
        title: "Child 1",
        parentId: "root"
      });
      const { graph: g3 } = createTestTask(g2, {
        id: "c2",
        title: "Child 2",
        parentId: "root"
      });
      const { graph: g4 } = createTestTask(g3, {
        id: "gc1",
        title: "Grandchild",
        parentId: "c1"
      });
      // Another unrelated root
      const { graph: g5 } = createTestTask(g4, {
        id: "other",
        title: "Other Root"
      });

      // Complete root's child1
      const g6 = startTask(g5, "c1")!;
      const g7 = completeTask(g6, "c1")!;

      // Get progress for just the root subtree
      const progress = getSubtreeProgress(g7, "root");
      expect(progress.total).toBe(4); // root + 2 children + grandchild
      expect(progress.complete).toBe(1); // c1
      expect(progress.pending).toBe(3);
      expect(progress.percentComplete).toBe(25);
    });
  });
});

// ============================================================================
// Serialization Tests
// ============================================================================

describe("Serialization", () => {
  let graph: TaskGraph;

  beforeEach(() => {
    graph = createTaskGraph();
  });

  describe("serializeGraph / deserializeGraph", () => {
    it("round-trips empty graph", () => {
      const serialized = serializeGraph(graph);
      const restored = deserializeGraph(serialized);

      expect(restored.tasks.size).toBe(0);
      expect(restored.rootTasks.size).toBe(0);
    });

    it("round-trips complex graph", () => {
      const { graph: g1, task: root } = createTestTask(graph, {
        id: "root",
        title: "Root"
      });
      const { graph: g2 } = createTestTask(g1, {
        id: "child",
        title: "Child",
        parentId: "root"
      });
      const g3 = startTask(g2, "root")!;
      const g4 = completeTask(g3, "root", "done")!;

      const serialized = serializeGraph(g4);
      const restored = deserializeGraph(serialized);

      expect(restored.tasks.size).toBe(2);
      expect(restored.rootTasks.has("root")).toBe(true);
      expect(restored.rootTasks.has("child")).toBe(false);

      const restoredRoot = restored.tasks.get("root")!;
      expect(restoredRoot.status).toBe("complete");
      expect(restoredRoot.result).toBe("done");
    });
  });

  describe("taskToRow / rowToTask", () => {
    it("converts task to row and back", () => {
      const now = Date.now();
      const task = createTask(
        {
          id: "test-id",
          type: "explore",
          title: "Test Task",
          description: "A description",
          parentId: "parent-1",
          dependencies: ["dep-1", "dep-2"],
          assignedTo: "agent-1",
          metadata: { priority: 1, tags: ["a", "b"] }
        },
        now
      );

      const row = taskToRow(task);

      expect(row.id).toBe("test-id");
      expect(row.parent_id).toBe("parent-1");
      expect(row.type).toBe("explore");
      expect(row.dependencies).toBe('["dep-1","dep-2"]');
      expect(row.metadata).toBe('{"priority":1,"tags":["a","b"]}');

      const restored = rowToTask(row);

      expect(restored.id).toBe(task.id);
      expect(restored.type).toBe(task.type);
      expect(restored.parentId).toBe(task.parentId);
      expect(restored.dependencies).toEqual(task.dependencies);
      expect(restored.metadata).toEqual(task.metadata);
    });

    it("handles null/undefined fields", () => {
      const task = createTask({
        type: "code",
        title: "Minimal"
      });

      const row = taskToRow(task);
      expect(row.parent_id).toBeNull();
      expect(row.description).toBeNull();
      expect(row.result).toBeNull();
      expect(row.metadata).toBeNull();

      const restored = rowToTask(row);
      expect(restored.parentId).toBeUndefined();
      expect(restored.description).toBeUndefined();
      expect(restored.result).toBeUndefined();
      expect(restored.metadata).toBeUndefined();
    });
  });
});

// ============================================================================
// Complex Workflow Tests
// ============================================================================

describe("Complex Workflows", () => {
  let graph: TaskGraph;

  beforeEach(() => {
    graph = createTaskGraph();
  });

  it("handles typical feature implementation workflow", () => {
    // Plan → Design → Implement → Test → Review
    const { graph: g1 } = createTestTask(graph, {
      id: "plan",
      type: "plan",
      title: "Plan feature"
    });
    const { graph: g2 } = createTestTask(g1, {
      id: "design",
      type: "explore",
      title: "Design architecture",
      dependencies: ["plan"]
    });
    const { graph: g3 } = createTestTask(g2, {
      id: "implement",
      type: "code",
      title: "Implement feature",
      dependencies: ["design"]
    });
    const { graph: g4 } = createTestTask(g3, {
      id: "test",
      type: "test",
      title: "Write tests",
      dependencies: ["implement"]
    });
    const { graph: g5 } = createTestTask(g4, {
      id: "review",
      type: "review",
      title: "Code review",
      dependencies: ["implement", "test"]
    });

    // Initially only "plan" is ready
    let ready = getReadyTasks(g5);
    expect(ready.length).toBe(1);
    expect(ready[0].id).toBe("plan");

    // Complete plan → design becomes ready
    let current = startTask(g5, "plan")!;
    current = completeTask(current, "plan", "Plan complete")!;

    ready = getReadyTasks(current);
    expect(ready.length).toBe(1);
    expect(ready[0].id).toBe("design");

    // Complete design → implement becomes ready
    current = startTask(current, "design")!;
    current = completeTask(current, "design")!;

    ready = getReadyTasks(current);
    expect(ready.map((t) => t.id)).toEqual(["implement"]);

    // Complete implement → test becomes ready
    current = startTask(current, "implement")!;
    current = completeTask(current, "implement")!;

    ready = getReadyTasks(current);
    expect(ready.map((t) => t.id)).toEqual(["test"]);

    // Complete test → review becomes ready (both deps satisfied)
    current = startTask(current, "test")!;
    current = completeTask(current, "test")!;

    ready = getReadyTasks(current);
    expect(ready.map((t) => t.id)).toEqual(["review"]);

    // Complete review → all done
    current = startTask(current, "review")!;
    current = completeTask(current, "review")!;

    ready = getReadyTasks(current);
    expect(ready.length).toBe(0);

    const progress = getProgress(current);
    expect(progress.complete).toBe(5);
    expect(progress.percentComplete).toBe(100);
  });

  it("handles parallel subtasks", () => {
    // Parent task with 3 parallel children
    const { graph: g1 } = createTestTask(graph, {
      id: "parent",
      title: "Parent task"
    });
    const { graph: g2 } = createTestTask(g1, {
      id: "sub1",
      title: "Subtask 1",
      parentId: "parent"
    });
    const { graph: g3 } = createTestTask(g2, {
      id: "sub2",
      title: "Subtask 2",
      parentId: "parent"
    });
    const { graph: g4 } = createTestTask(g3, {
      id: "sub3",
      title: "Subtask 3",
      parentId: "parent"
    });

    // All 4 tasks should be ready (no dependencies)
    let ready = getReadyTasks(g4);
    expect(ready.length).toBe(4);

    // Complete subtasks in parallel
    let current = startTask(g4, "sub1")!;
    current = startTask(current, "sub2")!;
    current = startTask(current, "sub3")!;

    expect(getActiveTasks(current).length).toBe(3);

    current = completeTask(current, "sub1")!;
    current = completeTask(current, "sub2")!;
    current = completeTask(current, "sub3")!;

    // Parent still pending
    const progress = getSubtreeProgress(current, "parent");
    expect(progress.complete).toBe(3);
    expect(progress.pending).toBe(1);
  });

  it("blocks dependent tasks when dependency fails", () => {
    const { graph: g1 } = createTestTask(graph, {
      id: "dep",
      title: "Dependency"
    });
    const { graph: g2 } = createTestTask(g1, {
      id: "dependent1",
      title: "Dependent 1",
      dependencies: ["dep"]
    });
    const { graph: g3 } = createTestTask(g2, {
      id: "dependent2",
      title: "Dependent 2",
      dependencies: ["dep"]
    });

    // Fail the dependency
    const started = startTask(g3, "dep")!;
    const failed = failTask(started, "dep", "Failed!")!;

    // Both dependents should now be blocked
    const blocked = getBlockedTasks(failed);
    expect(blocked.length).toBe(2);
    expect(blocked.map((t) => t.id).sort()).toEqual([
      "dependent1",
      "dependent2"
    ]);

    // No tasks should be ready
    expect(getReadyTasks(failed).length).toBe(0);
  });
});
