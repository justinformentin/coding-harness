import type { PlannerChecklistItem } from "./schemas.js";

export interface Scheduler {
  next(checklist: PlannerChecklistItem[]): PlannerChecklistItem | undefined;
}

/** Selects one runnable step in plan order. Dependencies must have passed. */
export class DependencyScheduler implements Scheduler {
  next(checklist: PlannerChecklistItem[]): PlannerChecklistItem | undefined {
    const passed = new Set(
      checklist
        .filter((item) => item.status === "passed")
        .map((item) => item.id),
    );
    return checklist.find(
      (item) =>
        (item.status === "pending" || item.status === "retryable") &&
        (item.dependencies ?? []).every((dependency) => passed.has(dependency)),
    );
  }
}

export function blockedSteps(checklist: PlannerChecklistItem[]): string[] {
  const passed = new Set(
    checklist.filter((item) => item.status === "passed").map((item) => item.id),
  );
  return checklist
    .filter(
      (item) =>
        item.status !== "passed" &&
        (item.dependencies ?? []).some((dependency) => !passed.has(dependency)),
    )
    .map((item) => item.id);
}
