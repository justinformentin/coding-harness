import { z } from "zod";
import { RunEventSchema, type RunEvent } from "./events.js";

export const RunProjectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1),
    status: z.enum([
      "created",
      "planning",
      "awaiting_approval",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "budget_exhausted",
    ]),
    lastSequence: z.number().int().min(-1),
    eventCount: z.number().int().nonnegative(),
    iteration: z.number().int().nonnegative(),
    completedSteps: z.array(z.string()),
    lastEventType: z.string().optional(),
  })
  .strict();

export type RunProjection = z.infer<typeof RunProjectionSchema>;

export function initialRunProjection(runId: string): RunProjection {
  return {
    schemaVersion: 1,
    runId,
    status: "created",
    lastSequence: -1,
    eventCount: 0,
    iteration: 0,
    completedSteps: [],
  };
}

/** Pure projection used by resume, inspection, and both user interfaces. */
export function reduceRunEvent(
  state: RunProjection,
  event: RunEvent,
): RunProjection {
  if (event.runId !== state.runId)
    throw new Error(`Event runId ${event.runId} does not match ${state.runId}`);
  if (event.sequence !== state.lastSequence + 1)
    throw new Error(
      `Expected event sequence ${state.lastSequence + 1}, got ${event.sequence}`,
    );

  let status = state.status;
  if (event.type === "plan_start") status = "planning";
  else if (event.type === "plan_review") status = "awaiting_approval";
  else if (event.type === "plan_approved" || event.type === "iteration_start")
    status = "running";
  else if (event.type === "complete") status = "succeeded";
  else if (event.type === "stopped" || event.type === "plan_rejected")
    status = "cancelled";
  else if (event.type === "max_iterations") status = "budget_exhausted";
  else if (event.type === "error") status = "failed";

  const completedSteps = new Set(state.completedSteps);
  if (event.type === "verify_complete") {
    const report = event.data.report;
    if (report && typeof report === "object") {
      const ids = (report as Record<string, unknown>).completedItems;
      if (Array.isArray(ids))
        for (const id of ids)
          if (typeof id === "string") completedSteps.add(id);
    }
  }

  return {
    ...state,
    status,
    lastSequence: event.sequence,
    eventCount: state.eventCount + 1,
    iteration:
      event.type === "iteration_start" &&
      typeof event.data.iteration === "number"
        ? event.data.iteration
        : state.iteration,
    completedSteps: [...completedSteps],
    lastEventType: event.type,
  };
}

export function replayRunEvents(
  runId: string,
  events: RunEvent[],
): RunProjection {
  return events.reduce(reduceRunEvent, initialRunProjection(runId));
}
