import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { ModelConfigSchema, type ModelConfig } from "./schemas.js";

const DEFAULT_CONFIG: ModelConfig = {
  planner: {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    temperature: 0.2,
  },
  executor: {
    provider: "local",
    model: "qwen2.5-coder:7b",
    baseUrl: "http://localhost:11434/v1",
    temperature: 0.2,
  },
  verifier: {
    provider: "local",
    model: "qwen2.5-coder:14b",
    baseUrl: "http://localhost:11434/v1",
    temperature: 0.1,
  },
};

export async function loadConfig(): Promise<ModelConfig> {
  let config: ModelConfig = {
    planner: { ...DEFAULT_CONFIG.planner },
    executor: { ...DEFAULT_CONFIG.executor },
    verifier: { ...DEFAULT_CONFIG.verifier },
  };

  // Load from .harness.json if it exists
  const configPath = ".harness.json";
  if (existsSync(configPath)) {
    try {
      const raw = await readFile(configPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      const result = ModelConfigSchema.safeParse(parsed);
      if (result.success) {
        config = result.data;
      } else {
        console.warn(
          `Warning: .harness.json has invalid format, using defaults`
        );
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`Warning: Could not read .harness.json: ${msg}`);
    }
  }

  // Override with environment variables
  if (process.env.HARNESS_PLANNER_PROVIDER)
    config.planner.provider = process.env.HARNESS_PLANNER_PROVIDER as
      | "openai"
      | "anthropic"
      | "local";
  if (process.env.HARNESS_PLANNER_MODEL)
    config.planner.model = process.env.HARNESS_PLANNER_MODEL;
  if (process.env.HARNESS_PLANNER_BASE_URL)
    config.planner.baseUrl = process.env.HARNESS_PLANNER_BASE_URL;
  if (process.env.HARNESS_EXECUTOR_PROVIDER)
    config.executor.provider = process.env.HARNESS_EXECUTOR_PROVIDER as
      | "openai"
      | "anthropic"
      | "local";
  if (process.env.HARNESS_EXECUTOR_MODEL)
    config.executor.model = process.env.HARNESS_EXECUTOR_MODEL;
  if (process.env.HARNESS_EXECUTOR_BASE_URL)
    config.executor.baseUrl = process.env.HARNESS_EXECUTOR_BASE_URL;
  if (process.env.HARNESS_VERIFIER_PROVIDER)
    config.verifier.provider = process.env.HARNESS_VERIFIER_PROVIDER as
      | "openai"
      | "anthropic"
      | "local";
  if (process.env.HARNESS_VERIFIER_MODEL)
    config.verifier.model = process.env.HARNESS_VERIFIER_MODEL;
  if (process.env.HARNESS_VERIFIER_BASE_URL)
    config.verifier.baseUrl = process.env.HARNESS_VERIFIER_BASE_URL;

  // API keys from env
  if (process.env.OPENAI_API_KEY && config.planner.provider === "openai") {
    config.planner.apiKey = process.env.OPENAI_API_KEY;
  }
  if (
    process.env.ANTHROPIC_API_KEY &&
    config.planner.provider === "anthropic"
  ) {
    config.planner.apiKey = process.env.ANTHROPIC_API_KEY;
  }

  return config;
}

export function printConfig(config: ModelConfig): string {
  return [
    "Model Configuration:",
    `  Planner:  ${config.planner.provider}/${config.planner.model}${config.planner.baseUrl ? ` @ ${config.planner.baseUrl}` : ""}`,
    `  Executor: ${config.executor.provider}/${config.executor.model}${config.executor.baseUrl ? ` @ ${config.executor.baseUrl}` : ""}`,
    `  Verifier: ${config.verifier.provider}/${config.verifier.model}${config.verifier.baseUrl ? ` @ ${config.verifier.baseUrl}` : ""}`,
  ].join("\n");
}
