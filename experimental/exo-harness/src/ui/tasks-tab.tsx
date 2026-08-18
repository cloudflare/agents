import { useCallback, useState } from "react";
import { Badge, Button, Empty, Text } from "@cloudflare/kumo";
import { AlarmIcon, XCircleIcon } from "@phosphor-icons/react";
import { TASK_BOUNDS, type ExoState, type TaskInfo } from "../kernel/types";
import { formatTime, type AgentCaller } from "./bits";

const STATE_VARIANT: Record<
  TaskInfo["state"],
  "primary" | "secondary" | "destructive"
> = {
  active: "primary",
  done: "secondary",
  cancelled: "secondary",
  disabled: "destructive"
};

/**
 * The "Tasks" tab — the agent's self-scheduled work. Scheduled turns run
 * autonomously outside the chat; their effects land in the journal and
 * here. Cancelling is forward-only history like everything else: the task
 * row stays, marked cancelled.
 */
export function TasksTab({
  agent,
  state
}: {
  agent: AgentCaller;
  state: ExoState;
}) {
  const [cancelling, setCancelling] = useState<string | null>(null);

  const cancel = useCallback(
    async (id: string) => {
      setCancelling(id);
      try {
        await agent.call("cancelTaskById", [id]);
      } finally {
        setCancelling(null);
      }
    },
    [agent]
  );

  if (state.tasks.length === 0) {
    return (
      <Empty
        icon={<AlarmIcon size={32} />}
        title="No scheduled tasks"
        description='Ask the agent to schedule work for its future self — e.g. "every night at 3am, curate your working memory".'
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      {state.tasks.map((task) => (
        <div key={task.id} className="px-3 py-2 border-b border-kumo-line">
          <div className="flex items-center gap-2">
            <Badge variant={STATE_VARIANT[task.state]}>{task.state}</Badge>
            <Badge variant="secondary">
              {task.kind === "cron"
                ? `cron ${task.spec}`
                : task.kind === "delay"
                  ? `once, +${task.spec}`
                  : `once, ${task.spec}`}
            </Badge>
            <span className="text-[10px] text-kumo-inactive ml-auto shrink-0">
              {task.runs} run{task.runs === 1 ? "" : "s"}
              {task.consecutiveFailures > 0 &&
                ` · ${task.consecutiveFailures} failing`}
            </span>
            {task.state === "active" && (
              <Button
                variant="ghost"
                shape="square"
                aria-label={`Cancel task ${task.id}`}
                loading={cancelling === task.id}
                onClick={() => cancel(task.id)}
                icon={<XCircleIcon size={14} />}
              />
            )}
          </div>
          <p className="mt-1 text-[11px] text-kumo-default whitespace-pre-wrap break-words">
            {task.instruction}
          </p>
          <div className="mt-1 flex items-center gap-3 text-[10px] text-kumo-inactive">
            <span className="font-mono">{task.id.slice(0, 8)}</span>
            {task.lastRunTs && <span>last: {formatTime(task.lastRunTs)}</span>}
            {task.nextRunTs && <span>next: {formatTime(task.nextRunTs)}</span>}
          </div>
        </div>
      ))}
      <div className="px-3 py-2">
        <Text size="xs" variant="secondary">
          Scheduled turns run outside the chat (max {TASK_BOUNDS.maxRunsPerDay}{" "}
          runs/day, one per {TASK_BOUNDS.minMsBetweenRuns / 60000} minutes; a
          task auto-disables after {TASK_BOUNDS.disableAfterConsecutiveFailures}{" "}
          consecutive failures). Everything they do lands in the journal.
        </Text>
      </div>
    </div>
  );
}
