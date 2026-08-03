import { z } from "zod";

export const ModelToolCallSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    arguments: z.record(z.unknown()),
  })
  .strict();
export type ModelToolCall = z.infer<typeof ModelToolCallSchema>;

export const ModelUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

export const ModelStopReasonSchema = z.enum([
  "stop",
  "tool_use",
  "truncated",
  "unknown",
]);
export type ModelStopReason = z.infer<typeof ModelStopReasonSchema>;

export const ModelResultSchema = z
  .object({
    text: z.string(),
    toolCalls: z.array(ModelToolCallSchema),
    usage: ModelUsageSchema,
    stopReason: ModelStopReasonSchema,
    provider: z.string().min(1),
    model: z.string().min(1),
    spanId: z.string().min(1),
  })
  .strict();
export type ModelResult = z.infer<typeof ModelResultSchema>;

export const ModelErrorKindSchema = z.enum([
  "transient",
  "rate_limit",
  "authentication",
  "policy",
  "invalid_request",
  "aborted",
  "unknown",
]);
export type ModelErrorKind = z.infer<typeof ModelErrorKindSchema>;

export type ModelTrace =
  | {
      phase: "start";
      spanId: string;
      provider: string;
      model: string;
      attempt: number;
    }
  | {
      phase: "end";
      spanId: string;
      provider: string;
      model: string;
      attempt: number;
      durationMs: number;
      result?: ModelResult;
      error?: { kind: ModelErrorKind; message: string };
    };
