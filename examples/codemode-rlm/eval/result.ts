export type Condition = "rlm" | "basic-think";

export type ConditionRun = {
  taskId: string;
  condition: Condition;
  status: "completed" | "error";
  elapsedMs: number;
  answer: string;
  error?: string;
  executionIds?: string[];
  recursiveCalls?: number | null;
};

function terminalDiagnostics(
  condition: Condition,
  result: Record<string, unknown>
): Pick<ConditionRun, "executionIds" | "recursiveCalls"> {
  return {
    ...(Array.isArray(result.executionIds) &&
    result.executionIds.every((id) => typeof id === "string")
      ? { executionIds: result.executionIds as string[] }
      : {}),
    ...(condition === "rlm"
      ? {
          recursiveCalls:
            typeof result.recursiveCalls === "number"
              ? result.recursiveCalls
              : null
        }
      : {})
  };
}

/** Project one terminal API response without dropping failure diagnostics. */
export function terminalRun(
  taskId: string,
  condition: Condition,
  elapsedMs: number,
  result: Record<string, unknown>
): ConditionRun {
  const diagnostics = terminalDiagnostics(condition, result);
  if (result.status !== "completed" || typeof result.answer !== "string") {
    return {
      taskId,
      condition,
      status: "error",
      elapsedMs,
      answer: "",
      error:
        typeof result.error === "string"
          ? result.error
          : `turn ended with ${String(result.status)}`,
      ...diagnostics
    };
  }
  return {
    taskId,
    condition,
    status: "completed",
    elapsedMs,
    answer: result.answer,
    ...diagnostics
  };
}
