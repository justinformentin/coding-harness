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

export const PlannerChecklistItemSchema = ChecklistItemSchema.extend({
  verifierConfig: VerifierConfigSchema.optional(),
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

export const ProviderSchema = z.enum(["openai", "anthropic", "local"]);
export type Provider = z.infer<typeof ProviderSchema>;

export const RoleModelConfigSchema = z.object({
  provider: ProviderSchema,
  model: z.string(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  temperature: z.number().optional(),
});

export type RoleModelConfig = z.infer<typeof RoleModelConfigSchema>;

export const ModelConfigSchema = z.object({
  planner: RoleModelConfigSchema,
  executor: RoleModelConfigSchema,
  verifier: RoleModelConfigSchema,
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

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
  iteration: z.number(),
  maxIterations: z.number(),
  runId: z.string(),
  startedAt: z.number(),
});

export type HarnessState = z.infer<typeof HarnessStateSchema>;
