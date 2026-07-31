import { z } from "zod";
export const StopReasonSchema = z.enum([
  "completed",
  "cancelled",
  "max_attempts",
  "max_model_calls",
  "max_tool_calls",
  "deadline",
  "no_progress",
  "blocked",
  "fatal_error",
]);
export const RunResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string(),
    status: z.enum([
      "succeeded",
      "failed",
      "cancelled",
      "budget_exhausted",
      "awaiting_review",
    ]),
    stopReason: StopReasonSchema,
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    passedSteps: z.array(z.string()),
    failedSteps: z.array(z.string()),
  })
  .strict();
export type RunResult = z.infer<typeof RunResultSchema>;
