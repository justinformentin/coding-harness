import { z } from "zod";
export {
  ProviderSchema,
  RoleModelConfigSchema,
  ResolvedConfigSchema,
  type Provider,
  type RoleModelConfig,
  type ResolvedConfig,
} from "./contracts/config.js";
import { AssertionSchema, type Assertion } from "./contracts/plan.js";

export const MessageSchema = z.object({
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string(),
  toolCallId: z.string().optional(),
  toolCalls: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        arguments: z.string(),
      }),
    )
    .optional(),
});

export type Message = z.infer<typeof MessageSchema>;

export const ChecklistItemSchema = z.object({
  id: z.string(),
  description: z.string(),
  status: z.enum([
    "pending",
    "ready",
    "executing",
    "verifying",
    "passed",
    "retryable",
    "blocked",
    "failed",
    "skipped",
  ]),
  acceptanceCriteria: z.array(z.string()),
  evidenceRequired: z.array(z.string()),
  evidenceFound: z.array(z.string()),
});

export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

export const PlannerChecklistItemSchema = ChecklistItemSchema.extend({
  suggestedCommands: z.array(z.string()).optional(),
  dependencies: z.array(z.string()).default([]),
  assertions: z.array(AssertionSchema).min(1),
});

export type PlannerChecklistItem = z.infer<typeof PlannerChecklistItemSchema>;

export const PlannerOutputSchema = z.object({
  goal: z.string(),
  checklist: z.array(PlannerChecklistItemSchema),
});

export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

export const VerifierReportSchema = z.object({
  done: z.boolean(),
  completedItems: z.array(z.string()),
  incompleteItems: z.array(z.string()),
  missingEvidence: z.array(z.string()),
  nextInstruction: z.string(),
});

export type VerifierReport = z.infer<typeof VerifierReportSchema>;

// Tool calling types
export const ToolCallSchema = z.object({
  id: z.string(),
  tool_name: z.string(),
  arguments: z.record(z.unknown()),
});

export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.unknown()),
});

export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export const ChatResponseSchema = z.object({
  content: z.string(),
  toolCalls: z.array(ToolCallSchema).optional(),
});

export type ChatResponse = z.infer<typeof ChatResponseSchema>;

export type ChatOptions = {
  temperature?: number;
  responseFormat?: "json_object" | "text";
  tools?: ToolDefinition[];
  maxTokens?: number;
  signal?: AbortSignal;
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;
  };
  // Called once when the stream ends, with the provider's RAW stop reason
  // (OpenAI/local `finish_reason`, Anthropic `stop_reason`). undefined when the
  // provider didn't report one. Normalize via completion.normalizeStopReason.
  onFinish?: (rawStopReason: string | undefined) => void;
  // Live progress callbacks for the claude-code provider, whose subprocess only
  // yields its final text at the very end. Without these, callers that use the
  // non-streaming chat() (planner, verifier) see nothing until the run finishes.
  // Fires for each chunk of assistant-visible text as it streams.
  onToken?: (token: string) => void;
  // Fires for each tool the model invokes.
  onToolUse?: (use: { name: string; input: unknown }) => void;
};

export const ArtifactsSchema = z.object({
  filesChanged: z.array(z.string()),
  commandsRun: z.array(z.string()),
  commandOutputs: z.array(z.string()),
});

export type Artifacts = z.infer<typeof ArtifactsSchema>;

export const HarnessStateSchema = z.object({
  originalPrompt: z.string(),
  checklist: z.array(PlannerChecklistItemSchema),
  messages: z.array(MessageSchema),
  artifacts: ArtifactsSchema,
  verifierReport: VerifierReportSchema.optional(),
  // Checklist item ids the executor has explicitly declared complete (via the
  // `finish` tool on text providers, or a finished sub-Claude on claude-code).
  // This is the "work was done" signal the verifier uses for manual items.
  // Defaulted for backward compatibility with runs saved before this existed.
  executorClaims: z.array(z.string()).default([]),
  // Maps checklist item id → the claude-code session id of the sub-Claude that
  // last worked it. Lets a resumed run continue an interrupted item's own
  // session (`claude --resume`) instead of cold-starting a fresh one. Defaulted
  // for backward compatibility with runs saved before this existed.
  claudeSessions: z.record(z.string()).default({}),
  iteration: z.number(),
  // Hard cap on iterations, or undefined for no limit. Older runs persisted a
  // number; new runs may omit it entirely.
  maxIterations: z.number().optional(),
  runId: z.string(),
  startedAt: z.number(),
  stepAttempts: z.record(z.number().int().nonnegative()).default({}),
  modelCalls: z.number().int().nonnegative().default(0),
  toolCalls: z.number().int().nonnegative().default(0),
  noProgressCount: z.number().int().nonnegative().default(0),
  progressFingerprint: z.string().optional(),
  stopReason: z
    .enum([
      "completed",
      "cancelled",
      "max_attempts",
      "max_model_calls",
      "max_tool_calls",
      "deadline",
      "no_progress",
      "blocked",
      "fatal_error",
    ])
    .optional(),
  reviewRequired: z.array(z.string()).default([]),
});

export type HarnessState = z.infer<typeof HarnessStateSchema>;
