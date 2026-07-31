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
      "awaiting_review",
    ]),
    lastSequence: z.number().int().min(-1),
    eventCount: z.number().int().nonnegative(),
    iteration: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    stepAttempts: z.record(z.number().int().nonnegative()),
    stopReason: z.string().optional(),
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
    modelCalls: 0,
    toolCalls: 0,
    stepAttempts: {},
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
  else if (event.type === "complete")
    status =
      Array.isArray(event.data.state) ||
      !event.data.state ||
      typeof event.data.state !== "object" ||
      !Array.isArray(
        (event.data.state as Record<string, unknown>).reviewRequired,
      ) ||
      (
        (event.data.state as Record<string, unknown>)
          .reviewRequired as unknown[]
      ).length === 0
        ? "succeeded"
        : "awaiting_review";
  else if (event.type === "stopped" || event.type === "plan_rejected")
    status = "cancelled";
  else if (event.type === "max_iterations") status = "budget_exhausted";
  else if (event.type === "budget_exhausted") status = "budget_exhausted";
  else if (event.type === "blocked") status = "failed";
  else if (event.type === "error") status = "failed";

  let stopReason = state.stopReason;
  if (event.type === "complete") stopReason = "completed";
  else if (event.type === "stopped" || event.type === "plan_rejected")
    stopReason = "cancelled";
  else if (event.type === "max_iterations") stopReason = "max_attempts";
  else if (
    (event.type === "budget_exhausted" || event.type === "blocked") &&
    typeof event.data.reason === "string"
  )
    stopReason = event.data.reason;
  else if (event.type === "error") stopReason = "fatal_error";

  const completedSteps = new Set(state.completedSteps);
  if (
    event.type === "step_transition" &&
    typeof event.data.stepId === "string"
  ) {
    if (event.data.to === "passed") completedSteps.add(event.data.stepId);
    else completedSteps.delete(event.data.stepId);
  }
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
      event.type === "attempt_complete" &&
      typeof event.data.iteration === "number"
        ? event.data.iteration
        : state.iteration,
    modelCalls:
      event.type === "attempt_complete" &&
      typeof event.data.modelCalls === "number"
        ? event.data.modelCalls
        : state.modelCalls,
    toolCalls:
      event.type === "attempt_complete" &&
      typeof event.data.toolCalls === "number"
        ? event.data.toolCalls
        : state.toolCalls,
    stepAttempts:
      event.type === "attempt_complete" &&
      event.data.stepAttempts &&
      typeof event.data.stepAttempts === "object"
        ? (event.data.stepAttempts as Record<string, number>)
        : state.stepAttempts,
    stopReason,
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
