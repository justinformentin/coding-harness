import type { HarnessState, PlannerChecklistItem } from "./schemas.js";

export function createInitialState(
  prompt: string,
  maxIterations: number = 25
): HarnessState {
  const now = Date.now();
  const date = new Date(now).toISOString().split("T")[0];
  const seq = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
  return {
    originalPrompt: prompt,
    checklist: [],
    messages: [],
    artifacts: { filesChanged: [], commandsRun: [], commandOutputs: [] },
    iteration: 0,
    maxIterations,
    runId: `${date}-${seq}`,
    startedAt: now,
  };
}

export function getNextPendingItem(
  state: HarnessState
): PlannerChecklistItem | undefined {
  return state.checklist.find(
    (item) => item.status === "pending" || item.status === "in_progress"
  );
}

export function allItemsDone(state: HarnessState): boolean {
  return (
    state.checklist.length > 0 &&
    state.checklist.every((item) => item.status === "done")
  );
}
