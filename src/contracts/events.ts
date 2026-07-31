import { z } from "zod";
export const RunEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    timestamp: z.string().datetime(),
    runId: z.string().min(1),
    type: z.string().min(1),
    data: z.record(z.unknown()),
    spanId: z.string().optional(),
    parentSpanId: z.string().optional(),
    stepId: z.string().optional(),
    attempt: z.number().int().positive().optional(),
  })
  .strict();
export type RunEvent = z.infer<typeof RunEventSchema>;
