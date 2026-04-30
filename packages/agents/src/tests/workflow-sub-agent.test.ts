import { env } from "cloudflare:workers";
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
});
