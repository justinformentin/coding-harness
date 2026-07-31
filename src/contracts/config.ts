import { z } from "zod";

export const ProviderSchema = z.enum([
  "openai",
  "anthropic",
  "local",
  "claude-code",
]);
export type Provider = z.infer<typeof ProviderSchema>;

export const RoleModelConfigSchema = z
  .object({
    provider: ProviderSchema,
    model: z.string().min(1),
    baseUrl: z.string().url().optional(),
    apiKey: z.string().min(1).optional(),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
    thinking: z
      .object({
        enabled: z.boolean(),
        budgetTokens: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    localOptions: z
      .object({
        supportsToolCalling: z.boolean().optional(),
        supportsJsonMode: z.boolean().optional(),
        maxTokens: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    claudeCode: z
      .object({
        allowedTools: z.array(z.string()).optional(),
        disallowedTools: z.array(z.string()).optional(),
        dangerouslySkipPermissions: z.boolean().optional(),
        isolateConfig: z.boolean().optional(),
        settingSources: z
          .array(z.enum(["user", "project", "local"]))
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RoleModelConfig = z.infer<typeof RoleModelConfigSchema>;

export const ResolvedConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    planner: RoleModelConfigSchema,
    executor: RoleModelConfigSchema,
    verifier: RoleModelConfigSchema,
    maxIterations: z.number().int().positive().optional(),
    loop: z
      .object({
        maxAttemptsPerStep: z.number().int().positive(),
        maxModelCalls: z.number().int().positive(),
        maxToolCalls: z.number().int().positive(),
        deadlineSeconds: z.number().int().positive(),
        noProgressAttempts: z.number().int().positive(),
      })
      .strict(),
    workspace: z
      .object({
        root: z.string().min(1),
        allowWrite: z.array(z.string()),
        denyWrite: z.array(z.string()),
        commandTimeoutSeconds: z.number().int().positive(),
        maxOutputBytes: z.number().int().positive(),
      })
      .strict(),
    context: z
      .object({
        maxMessages: z.number().int().positive(),
        maxBytes: z.number().int().positive(),
      })
      .strict(),
    runs: z
      .object({
        directory: z.string().min(1),
        checkpointEveryEvents: z.number().int().positive(),
      })
      .strict(),
    tracing: z
      .object({ enabled: z.boolean(), captureModelText: z.boolean() })
      .strict(),
  })
  .strict();
export type ResolvedConfig = z.infer<typeof ResolvedConfigSchema>;

export type ConfigSource =
  | "default"
  | "user"
  | "project"
  | "environment"
  | "cli";
export type ConfigProvenance = Record<string, ConfigSource>;
