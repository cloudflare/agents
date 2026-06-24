import { env, exports } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "..";
import type { WorkflowInfo } from "../workflows";

type CallbackRecord = {
  type: string;
  workflowName: string;
  workflowId: string;
  data: unknown;
};

async function waitForCallback(
  loadCallbacks: () => Promise<CallbackRecord[]>,
  predicate: (callback: CallbackRecord) => boolean
): Promise<CallbackRecord[]> {
  for (let i = 0; i < 50; i++) {
    const callbacks = await loadCallbacks();
    if (callbacks.some(predicate)) {
      return callbacks;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const callbacks = await loadCallbacks();
  throw new Error(
    `Timed out waiting for callback. Received: ${JSON.stringify(callbacks)}`
  );
}

describe("sub-agent workflow origins", () => {
  it("routes callbacks and agent RPC to the originating facet", async () => {
    const id = crypto.randomUUID();
    const parentName = `facet-workflow-parent-${id}`;
    const childName = `facet-workflow-child-${id}`;
    const workflowId = `facet-origin-wf-${id}`;
    const taskId = `facet-task-${id}`;
    const agentStub = await getAgentByName(env.TestWorkflowAgent, parentName);

    await using instance = await introspectWorkflowInstance(
      env.FACET_ORIGIN_WORKFLOW,
      workflowId
    );

    const startedWorkflowId = await agentStub.runSubAgentWorkflowTest(
      childName,
      workflowId,
      { taskId }
    );

    expect(startedWorkflowId).toBe(workflowId);
    await expect(instance.waitForStatus("complete")).resolves.not.toThrow();

    const callbacks = (await agentStub.getSubAgentCallbacks(
      childName
    )) as CallbackRecord[];
    expect(callbacks).toEqual(
      expect.arrayContaining([
        {
          type: "progress",
          workflowName: "FACET_ORIGIN_WORKFLOW",
          workflowId,
          data: {
            progress: {
              step: "facet-origin",
              status: "running",
              taskId
            }
          }
        },
        {
          type: "complete",
          workflowName: "FACET_ORIGIN_WORKFLOW",
          workflowId,
          data: {
            result: {
              routedTo: "facet",
              taskId
            }
          }
        }
      ])
    );

    const results = await agentStub.getSubAgentWorkflowResults(childName);
    expect(results).toEqual([
      {
        taskId,
        result: {
          routedTo: "facet",
          taskId
        }
      },
      {
        taskId: `${taskId}:fetch-error`,
        result:
          "AgentWorkflow.agent for sub-agent origins is an RPC-only stub — .fetch() is not supported. Use routeSubAgentRequest() or the /agents/{parent}/{name}/sub/{child}/{name} URL for external HTTP/WS routing."
      }
    ]);

    const facetWorkflow = (await agentStub.getSubAgentWorkflowById(
      childName,
      workflowId
    )) as WorkflowInfo | null;
    expect(facetWorkflow?.workflowId).toBe(workflowId);
    expect(facetWorkflow?.workflowName).toBe("FACET_ORIGIN_WORKFLOW");
    expect(facetWorkflow?.status).toBe("complete");

    const parentWorkflow = (await agentStub.getWorkflowById(
      workflowId
    )) as WorkflowInfo | null;
    expect(parentWorkflow).toBeNull();
  });

  it("supports workflows started during facet onStart", async () => {
    const id = crypto.randomUUID();
    const parentName = `facet-workflow-on-start-parent-${id}`;
    const childName = `facet-workflow-on-start-child-${id}`;
    const workflowId = `facet-on-start-wf-${childName}`;
    const taskId = `facet-on-start-task-${childName}`;
    const agentStub = await getAgentByName(env.TestWorkflowAgent, parentName);

    await using instance = await introspectWorkflowInstance(
      env.FACET_ORIGIN_WORKFLOW,
      workflowId
    );

    const startedWorkflowId =
      await agentStub.spawnOnStartWorkflowSubAgent(childName);

    expect(startedWorkflowId).toBe(workflowId);
    await expect(instance.waitForStatus("complete")).resolves.not.toThrow();

    const callbacks = (await agentStub.getOnStartSubAgentCallbacks(
      childName
    )) as CallbackRecord[];
    expect(callbacks).toEqual(
      expect.arrayContaining([
        {
          type: "complete",
          workflowName: "FACET_ORIGIN_WORKFLOW",
          workflowId,
          data: {
            result: {
              routedTo: "facet",
              taskId
            }
          }
        }
      ])
    );

    const results =
      await agentStub.getOnStartSubAgentWorkflowResults(childName);
    expect(results).toEqual(
      expect.arrayContaining([
        {
          taskId,
          result: {
            routedTo: "facet",
            taskId
          }
        }
      ])
    );

    const facetWorkflow = (await agentStub.getOnStartSubAgentWorkflowById(
      childName,
      workflowId
    )) as WorkflowInfo | null;
    expect(facetWorkflow?.status).toBe("complete");
  });

  it("routes workflow RPC and callbacks through nested facet paths", async () => {
    const id = crypto.randomUUID();
    const parentName = `facet-workflow-nested-parent-${id}`;
    const childName = `facet-workflow-nested-child-${id}`;
    const grandchildName = `facet-workflow-nested-grandchild-${id}`;
    const workflowId = `facet-nested-wf-${id}`;
    const taskId = `facet-nested-task-${id}`;
    const agentStub = await getAgentByName(env.TestWorkflowAgent, parentName);

    await using instance = await introspectWorkflowInstance(
      env.FACET_ORIGIN_WORKFLOW,
      workflowId
    );

    const startedWorkflowId = await agentStub.runNestedSubAgentWorkflowTest(
      childName,
      grandchildName,
      workflowId,
      { taskId }
    );

    expect(startedWorkflowId).toBe(workflowId);
    await expect(instance.waitForStatus("complete")).resolves.not.toThrow();

    const grandchildCallbacks = (await agentStub.getNestedSubAgentCallbacks(
      childName,
      grandchildName
    )) as CallbackRecord[];
    expect(grandchildCallbacks).toEqual(
      expect.arrayContaining([
        {
          type: "complete",
          workflowName: "FACET_ORIGIN_WORKFLOW",
          workflowId,
          data: {
            result: {
              routedTo: "facet",
              taskId
            }
          }
        }
      ])
    );

    const grandchildResults = await agentStub.getNestedSubAgentWorkflowResults(
      childName,
      grandchildName
    );
    expect(grandchildResults).toEqual(
      expect.arrayContaining([
        {
          taskId,
          result: {
            routedTo: "facet",
            taskId
          }
        }
      ])
    );

    const parentWorkflow = (await agentStub.getWorkflowById(
      workflowId
    )) as WorkflowInfo | null;
    expect(parentWorkflow).toBeNull();

    const childWorkflow = (await agentStub.getSubAgentWorkflowById(
      childName,
      workflowId
    )) as WorkflowInfo | null;
    expect(childWorkflow).toBeNull();

    const grandchildWorkflow = (await agentStub.getNestedSubAgentWorkflowById(
      childName,
      grandchildName,
      workflowId
    )) as WorkflowInfo | null;
    expect(grandchildWorkflow?.status).toBe("complete");
  });

  it("routes workflow errors to the originating facet", async () => {
    const id = crypto.randomUUID();
    const parentName = `facet-workflow-error-parent-${id}`;
    const childName = `facet-workflow-error-child-${id}`;
    const workflowId = `facet-error-wf-${id}`;
    const message = `facet error ${id}`;
    const agentStub = await getAgentByName(env.TestWorkflowAgent, parentName);

    await using instance = await introspectWorkflowInstance(
      env.THROW_IN_RUN_WORKFLOW,
      workflowId
    );

    const startedWorkflowId = await agentStub.runSubAgentErrorWorkflowTest(
      childName,
      workflowId,
      { message }
    );

    expect(startedWorkflowId).toBe(workflowId);
    await expect(instance.waitForStatus("errored")).resolves.not.toThrow();

    const callbacks = (await agentStub.getSubAgentCallbacks(
      childName
    )) as CallbackRecord[];
    expect(callbacks).toEqual(
      expect.arrayContaining([
        {
          type: "error",
          workflowName: "THROW_IN_RUN_WORKFLOW",
          workflowId,
          data: {
            error: message
          }
        }
      ])
    );

    const facetWorkflow = (await agentStub.getSubAgentWorkflowById(
      childName,
      workflowId
    )) as WorkflowInfo | null;
    expect(facetWorkflow?.status).toBe("errored");
  });

  it("approves facet-origin workflows through the child stub", async () => {
    const id = crypto.randomUUID();
    const parentName = `facet-workflow-approval-parent-${id}`;
    const childName = `facet-workflow-approval-child-${id}`;
    const workflowId = `facet-approval-wf-${id}`;
    const taskId = `facet-approval-task-${id}`;
    const agentStub = await getAgentByName(env.TestWorkflowAgent, parentName);

    await using instance = await introspectWorkflowInstance(
      env.FACET_APPROVAL_WORKFLOW,
      workflowId
    );

    const startedWorkflowId = await agentStub.runSubAgentApprovalWorkflowTest(
      childName,
      workflowId,
      { taskId }
    );

    expect(startedWorkflowId).toBe(workflowId);
    await waitForCallback(
      async () =>
        (await agentStub.getSubAgentCallbacks(childName)) as CallbackRecord[],
      (callback) =>
        callback.type === "progress" &&
        callback.workflowName === "FACET_APPROVAL_WORKFLOW" &&
        callback.workflowId === workflowId
    );

    await agentStub.approveSubAgentWorkflow(childName, workflowId);
    await expect(instance.waitForStatus("complete")).resolves.not.toThrow();

    const results = await agentStub.getSubAgentWorkflowResults(childName);
    expect(results).toEqual([
      {
        taskId,
        result: {
          approved: true,
          approvedVia: "parent-child-stub",
          taskId
        }
      }
    ]);

    const facetWorkflow = (await agentStub.getSubAgentWorkflowById(
      childName,
      workflowId
    )) as WorkflowInfo | null;
    expect(facetWorkflow?.status).toBe("complete");
  });

  it("rejects facet-origin workflows through the child stub", async () => {
    const id = crypto.randomUUID();
    const parentName = `facet-workflow-rejection-parent-${id}`;
    const childName = `facet-workflow-rejection-child-${id}`;
    const workflowId = `facet-rejection-wf-${id}`;
    const taskId = `facet-rejection-task-${id}`;
    const agentStub = await getAgentByName(env.TestWorkflowAgent, parentName);

    await using instance = await introspectWorkflowInstance(
      env.FACET_APPROVAL_WORKFLOW,
      workflowId
    );

    const startedWorkflowId = await agentStub.runSubAgentApprovalWorkflowTest(
      childName,
      workflowId,
      { taskId }
    );

    expect(startedWorkflowId).toBe(workflowId);
    await waitForCallback(
      async () =>
        (await agentStub.getSubAgentCallbacks(childName)) as CallbackRecord[],
      (callback) =>
        callback.type === "progress" &&
        callback.workflowName === "FACET_APPROVAL_WORKFLOW" &&
        callback.workflowId === workflowId
    );

    await agentStub.rejectSubAgentWorkflow(childName, workflowId);
    await expect(instance.waitForStatus("errored")).resolves.not.toThrow();

    const callbacks = (await agentStub.getSubAgentCallbacks(
      childName
    )) as CallbackRecord[];
    expect(callbacks).toEqual(
      expect.arrayContaining([
        {
          type: "error",
          workflowName: "FACET_APPROVAL_WORKFLOW",
          workflowId,
          data: {
            error: "Rejected from parent via child stub"
          }
        }
      ])
    );

    const facetWorkflow = (await agentStub.getSubAgentWorkflowById(
      childName,
      workflowId
    )) as WorkflowInfo | null;
    expect(facetWorkflow?.status).toBe("errored");
  });

  it("routes durable event callbacks and state updates to the originating facet", async () => {
    const id = crypto.randomUUID();
    const parentName = `facet-workflow-state-parent-${id}`;
    const childName = `facet-workflow-state-child-${id}`;
    const workflowId = `facet-event-state-wf-${id}`;
    const taskId = `facet-event-state-task-${id}`;
    const agentStub = await getAgentByName(env.TestWorkflowAgent, parentName);

    await using instance = await introspectWorkflowInstance(
      env.FACET_EVENT_STATE_WORKFLOW,
      workflowId
    );

    const startedWorkflowId = await agentStub.runSubAgentEventStateWorkflowTest(
      childName,
      workflowId,
      { taskId }
    );

    expect(startedWorkflowId).toBe(workflowId);
    await expect(instance.waitForStatus("complete")).resolves.not.toThrow();

    const callbacks = (await agentStub.getSubAgentCallbacks(
      childName
    )) as CallbackRecord[];
    expect(callbacks).toEqual(
      expect.arrayContaining([
        {
          type: "event",
          workflowName: "FACET_EVENT_STATE_WORKFLOW",
          workflowId,
          data: {
            event: {
              kind: "facet-event",
              taskId
            }
          }
        },
        {
          type: "complete",
          workflowName: "FACET_EVENT_STATE_WORKFLOW",
          workflowId,
          data: {
            result: {
              taskId,
              resetState: {
                status: "initial",
                count: 0
              }
            }
          }
        }
      ])
    );

    const results = await agentStub.getSubAgentWorkflowResults(childName);
    expect(results).toEqual([
      {
        taskId: `${taskId}:after-set`,
        result: {
          status: "set",
          count: 1
        }
      },
      {
        taskId: `${taskId}:after-merge`,
        result: {
          status: "merged",
          count: 1
        }
      },
      {
        taskId: `${taskId}:after-reset`,
        result: {
          status: "initial",
          count: 0
        }
      }
    ]);

    const facetWorkflow = (await agentStub.getSubAgentWorkflowById(
      childName,
      workflowId
    )) as WorkflowInfo | null;
    expect(facetWorkflow?.status).toBe("complete");
  });

  it("routes callbacks to a facet that was restarted mid-workflow", async () => {
    const id = crypto.randomUUID();
    const parentName = `facet-workflow-restart-parent-${id}`;
    const childName = `facet-workflow-restart-child-${id}`;
    const workflowId = `facet-restart-wf-${id}`;
    const taskId = `facet-restart-task-${id}`;
    const agentStub = await getAgentByName(env.TestWorkflowAgent, parentName);

    await using instance = await introspectWorkflowInstance(
      env.FACET_APPROVAL_WORKFLOW,
      workflowId
    );

    // Start an approval workflow that parks on waitForApproval, so the run
    // spans an explicit facet restart.
    const startedWorkflowId = await agentStub.runSubAgentApprovalWorkflowTest(
      childName,
      workflowId,
      { taskId }
    );
    expect(startedWorkflowId).toBe(workflowId);

    // Wait until the in-flight "progress" callback has landed on the facet.
    await waitForCallback(
      async () =>
        (await agentStub.getSubAgentCallbacks(childName)) as CallbackRecord[],
      (callback) =>
        callback.type === "progress" &&
        callback.workflowName === "FACET_APPROVAL_WORKFLOW" &&
        callback.workflowId === workflowId
    );

    // Forcibly abort the facet. This drops its in-memory state (including the
    // in-memory callback log) and tears down the isolate. The durable workflow
    // tracking row in the facet's own SQLite survives.
    await agentStub.abortWorkflowSubAgent(childName);

    // Approve from the parent. The workflow resumes and fires its completion
    // callbacks, which must route to a freshly re-initialized facet.
    await agentStub.approveSubAgentWorkflow(childName, workflowId);
    await expect(instance.waitForStatus("complete")).resolves.not.toThrow();

    // The completion callback landed on the restarted facet (the pre-restart
    // "progress" entry is gone because in-memory state was dropped).
    const callbacks = await waitForCallback(
      async () =>
        (await agentStub.getSubAgentCallbacks(childName)) as CallbackRecord[],
      (callback) =>
        callback.type === "complete" && callback.workflowId === workflowId
    );
    expect(
      callbacks.some(
        (callback) =>
          callback.type === "progress" && callback.workflowId === workflowId
      )
    ).toBe(false);

    // The durable tracking row, read back through the registry, reflects the
    // callback that routed to the post-restart facet.
    const facetWorkflow = (await agentStub.getSubAgentWorkflowById(
      childName,
      workflowId
    )) as WorkflowInfo | null;
    expect(facetWorkflow?.status).toBe("complete");
  });

  it("rejects callbacks for a sub-agent deleted mid-flight and refuses unsafe methods", async () => {
    const id = crypto.randomUUID();
    const parentName = `facet-workflow-guard-parent-${id}`;
    const childName = `facet-workflow-guard-child-${id}`;
    const agentStub = await getAgentByName(env.TestWorkflowAgent, parentName);

    // Materialize the child facet, then delete it so the registry no longer
    // knows about it — the state a long-running workflow would hit if its
    // origin facet was deleted while the run was parked.
    await agentStub.runSubAgentWorkflowTest(childName, `seed-wf-${id}`, {
      taskId: `seed-${id}`
    });
    await agentStub.deleteWorkflowSubAgent(childName);

    // A callback targeting the deleted child surfaces a clear error rather
    // than silently succeeding or hanging.
    const deleted = await agentStub.invokeAgentPathTest(
      [
        { className: "TestWorkflowAgent", name: parentName },
        { className: "TestWorkflowSubAgent", name: childName }
      ],
      "recordWorkflowResult",
      ["x", { y: 1 }]
    );
    expect(deleted.ok).toBe(false);
    expect(deleted.message).toContain("no longer exists");

    // A path that does not descend from this agent is rejected.
    const notDescend = await agentStub.invokeAgentPathTest(
      [{ className: "SomeOtherAgent", name: "nope" }],
      "getCallbacksReceived",
      []
    );
    expect(notDescend.ok).toBe(false);
    expect(notDescend.message).toContain("does not descend");

    // Built-in / prototype methods are refused, matching real DO-stub RPC.
    const builtin = await agentStub.invokeAgentPathTest(
      [{ className: "TestWorkflowAgent", name: parentName }],
      "constructor",
      []
    );
    expect(builtin.ok).toBe(false);
    expect(builtin.message).toContain("not callable");

    const hasOwn = await agentStub.invokeAgentPathTest(
      [{ className: "TestWorkflowAgent", name: parentName }],
      "hasOwnProperty",
      ["name"]
    );
    expect(hasOwn.ok).toBe(false);
    expect(hasOwn.message).toContain("not callable");
  });

  it("reaches a workflow facet over HTTP via routeSubAgentRequest while a workflow runs", async () => {
    const id = crypto.randomUUID();
    const parentName = `facet-workflow-http-parent-${id}`;
    const childName = `facet-workflow-http-child-${id}`;
    const workflowId = `facet-http-wf-${id}`;
    const taskId = `facet-http-task-${id}`;
    const agentStub = await getAgentByName(env.TestWorkflowAgent, parentName);

    await using instance = await introspectWorkflowInstance(
      env.FACET_APPROVAL_WORKFLOW,
      workflowId
    );

    // Park a workflow on the facet so it is live during the HTTP request.
    await agentStub.runSubAgentApprovalWorkflowTest(childName, workflowId, {
      taskId
    });
    await waitForCallback(
      async () =>
        (await agentStub.getSubAgentCallbacks(childName)) as CallbackRecord[],
      (callback) =>
        callback.type === "progress" && callback.workflowId === workflowId
    );

    // `AgentWorkflow.agent.fetch()` is intentionally unsupported; the
    // documented escape hatch is `routeSubAgentRequest()` / the nested
    // `/sub/...` URL. Confirm that reaches the running facet.
    const res = await exports.default.fetch(
      `http://example.com/wf-sub/${parentName}/sub/test-workflow-sub-agent/${childName}?workflowId=${workflowId}`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      facet: string;
      isFacet: boolean;
      workflowStatus: string | null;
    };
    expect(body.facet).toBe(childName);
    expect(body.isFacet).toBe(true);
    expect(body.workflowStatus).not.toBeNull();

    // Clean up the parked workflow.
    await agentStub.approveSubAgentWorkflow(childName, workflowId);
    await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
  });

  it("resumes a legacy workflow started without an origin payload", async () => {
    // A workflow that was already in flight when an older `agents` build was
    // upgraded carries only `__agentName` / `__agentBinding` / `__workflowName`
    // in its params and no `__agentOrigin`. AgentWorkflow._initAgent() must
    // fall back to the legacy name+binding path so its callbacks and
    // `this.agent` RPC still reach the originating top-level Agent.
    const id = crypto.randomUUID();
    const agentName = `legacy-origin-agent-${id}`;
    const workflowId = `legacy-origin-wf-${id}`;
    const taskId = `legacy-origin-task-${id}`;
    const agentStub = await getAgentByName(env.TestWorkflowAgent, agentName);

    await using instance = await introspectWorkflowInstance(
      env.TEST_WORKFLOW,
      workflowId
    );

    const startedWorkflowId = await agentStub.runLegacyTopLevelWorkflowTest(
      workflowId,
      { taskId }
    );
    expect(startedWorkflowId).toBe(workflowId);
    await expect(instance.waitForStatus("complete")).resolves.not.toThrow();

    // `this.agent.recordWorkflowResult(...)` RPC resolved against the legacy
    // name+binding origin and landed on the originating Agent.
    const results = (await agentStub.getWorkflowResults()) as Array<{
      taskId: string;
      result: unknown;
    }>;
    expect(results.some((entry) => entry.taskId === taskId)).toBe(true);

    // The durable completion callback routed back and updated tracking.
    const tracked = (await agentStub.getWorkflowById(
      workflowId
    )) as WorkflowInfo | null;
    expect(tracked?.status).toBe("complete");
  });
});
