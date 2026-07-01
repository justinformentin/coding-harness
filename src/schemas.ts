import { z } from "zod";

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
      })
    )
    .optional(),
});

export type Message = z.infer<typeof MessageSchema>;

export const ChecklistItemSchema = z.object({
  id: z.string(),
  description: z.string(),
  status: z.enum(["pending", "in_progress", "done", "failed"]),
  acceptanceCriteria: z.array(z.string()),
  evidenceRequired: z.array(z.string()),
  evidenceFound: z.array(z.string()),
});

export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

export const VerifierConfigSchema = z.object({
  requiredCommands: z.array(z.string()).optional(),
  requiredFiles: z.array(z.string()).optional(),
  requiredPatterns: z.array(z.string()).optional(),
  forbiddenPatterns: z.array(z.string()).optional(),
  successIndicators: z.array(z.string()).optional(),
});

export type VerifierConfig = z.infer<typeof VerifierConfigSchema>;

// How an item should be verified once the executor has attempted it:
//   - "deterministic": checked purely in code via verifierConfig (file exists,
//     command ran, pattern present). No LLM involved.
//   - "manual": success is subjective and can't be checked mechanically; we
//     only confirm the work was attempted (the executor's finish claim) and
//     defer any content judgment to a later human review.
//   - "llm": genuinely needs semantic judgment now; verified per-item by the
//     verifier model. Reserve for cases the other two can't cover.
export const VerificationKindSchema = z.enum([
  "deterministic",
  "manual",
  "llm",
]);
export type VerificationKind = z.infer<typeof VerificationKindSchema>;

export const PlannerChecklistItemSchema = ChecklistItemSchema.extend({
  verifierConfig: VerifierConfigSchema.optional(),
  // Chosen by the planner. When omitted, the verifier infers it: deterministic
  // if a non-empty verifierConfig is present, otherwise manual.
  verificationKind: VerificationKindSchema.optional(),
  suggestedCommands: z.array(z.string()).optional(),
  dependencies: z.array(z.string()).optional(),
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

export const ProviderSchema = z.enum([
  "openai",
  "anthropic",
  "local",
  "claude-code",
]);
export type Provider = z.infer<typeof ProviderSchema>;

export const RoleModelConfigSchema = z.object({
  provider: ProviderSchema,
  model: z.string(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  thinking: z
    .object({
      enabled: z.boolean(),
      budgetTokens: z.number().optional(),
    })
    .optional(),
  localOptions: z
    .object({
      supportsToolCalling: z.boolean().optional(),
      supportsJsonMode: z.boolean().optional(),
      maxTokens: z.number().optional(),
    })
    .optional(),
  // Options for the "claude-code" provider, which shells out to the local
  // `claude` CLI (using whatever auth the user already logged in with).
  claudeCode: z
    .object({
      allowedTools: z.array(z.string()).optional(),
      disallowedTools: z.array(z.string()).optional(),
      dangerouslySkipPermissions: z.boolean().optional(),
    })
    .optional(),
});

export type RoleModelConfig = z.infer<typeof RoleModelConfigSchema>;

export const ModelConfigSchema = z.object({
  planner: RoleModelConfigSchema,
  executor: RoleModelConfigSchema,
  verifier: RoleModelConfigSchema,
  // Optional hard cap on the execute/verify loop. Omitted = no limit (the
  // loop runs until the verifier reports done). Can also be set via the
  // HARNESS_MAX_ITERATIONS env var or the --max-iterations CLI flag.
  maxIterations: z.number().int().positive().optional(),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

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
  iteration: z.number(),
  // Hard cap on iterations, or undefined for no limit. Older runs persisted a
  // number; new runs may omit it entirely.
  maxIterations: z.number().optional(),
  runId: z.string(),
  startedAt: z.number(),
});

export type HarnessState = z.infer<typeof HarnessStateSchema>;
