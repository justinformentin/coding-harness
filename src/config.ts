import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import {
  ResolvedConfigSchema,
  type ConfigProvenance,
  type ConfigSource,
  type ResolvedConfig,
} from "./contracts/config.js";

export const DEFAULT_CONFIG: ResolvedConfig = {
  schemaVersion: 1,
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
  loop: {
    maxAttemptsPerStep: 3,
    maxModelCalls: 40,
    maxToolCalls: 100,
    deadlineSeconds: 3600,
    noProgressAttempts: 2,
  },
  workspace: {
    root: ".",
    allowWrite: ["**"],
    denyWrite: [".git/**", ".runs/**"],
    commandTimeoutSeconds: 120,
    maxOutputBytes: 100000,
  },
  context: { maxMessages: 40, maxBytes: 200000 },
  runs: { directory: ".runs", checkpointEveryEvents: 25 },
  tracing: { enabled: true, captureModelText: true },
};

export class ConfigError extends Error {
  constructor(public diagnostics: string[]) {
    super(
      `Configuration is invalid:\n${diagnostics.map((d) => `  - ${d}`).join("\n")}`,
    );
  }
}
export type LoadConfigOptions = {
  cwd?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  env?: NodeJS.ProcessEnv;
  cli?: Record<string, unknown>;
};
export type LoadedConfig = {
  config: ResolvedConfig;
  provenance: ConfigProvenance;
};

function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function merge(
  target: Record<string, unknown>,
  input: Record<string, unknown>,
  source: ConfigSource,
  provenance: ConfigProvenance,
  prefix = "",
): void {
  for (const [key, value] of Object.entries(input)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (plain(value) && plain(target[key]))
      merge(
        target[key] as Record<string, unknown>,
        value,
        source,
        provenance,
        path,
      );
    else {
      target[key] = value;
      provenance[path] = source;
    }
  }
}
async function readObject(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new ConfigError([
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  if (!plain(parsed))
    throw new ConfigError([`${path}: expected a JSON object`]);
  return parsed;
}
function environmentConfig(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const roles = ["planner", "executor", "verifier"] as const;
  for (const role of roles) {
    const upper = role.toUpperCase();
    const values: Record<string, unknown> = {};
    for (const [suffix, key] of [
      ["PROVIDER", "provider"],
      ["MODEL", "model"],
      ["BASE_URL", "baseUrl"],
    ] as const)
      if (env[`HARNESS_${upper}_${suffix}`])
        values[key] = env[`HARNESS_${upper}_${suffix}`];
    if (Object.keys(values).length) out[role] = values;
  }
  if (env.HARNESS_MAX_ITERATIONS)
    out.maxIterations = Number(env.HARNESS_MAX_ITERATIONS);
  return out;
}
function injectSecrets(config: ResolvedConfig, env: NodeJS.ProcessEnv): void {
  for (const role of [config.planner, config.executor, config.verifier]) {
    const key = role.apiKeyEnv
      ? env[role.apiKeyEnv]
      : role.provider === "openai"
        ? env.OPENAI_API_KEY
        : role.provider === "anthropic"
          ? env.ANTHROPIC_API_KEY
          : undefined;
    if (key) role.apiKey = key;
  }
}

export async function resolveConfig(
  options: LoadConfigOptions = {},
): Promise<LoadedConfig> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const provenance: ConfigProvenance = {};
  const raw = structuredClone(DEFAULT_CONFIG) as unknown as Record<
    string,
    unknown
  >;
  const markDefaults = (obj: Record<string, unknown>, prefix = "") => {
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (plain(value)) markDefaults(value, path);
      else provenance[path] = "default";
    }
  };
  markDefaults(raw);
  const layers: Array<[string, ConfigSource]> = [
    [
      options.userConfigPath ??
        join(homedir(), ".config", "coding-harness", "config.json"),
      "user",
    ],
    [options.projectConfigPath ?? join(cwd, ".harness.json"), "project"],
  ];
  for (const [path, source] of layers) {
    const value = await readObject(path);
    if (value) {
      if (value.schemaVersion !== 1)
        throw new ConfigError([`${path}: schemaVersion must be 1`]);
      merge(raw, value, source, provenance);
    }
  }
  merge(raw, environmentConfig(env), "environment", provenance);
  if (options.cli) merge(raw, options.cli, "cli", provenance);
  const parsed = ResolvedConfigSchema.safeParse(raw);
  if (!parsed.success)
    throw new ConfigError(
      parsed.error.issues.map(
        (i) => `${i.path.join(".") || "config"}: ${i.message}`,
      ),
    );
  injectSecrets(parsed.data, env);
  return { config: parsed.data, provenance };
}

export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<ResolvedConfig> {
  return (await resolveConfig(options)).config;
}
export function redactConfig(config: ResolvedConfig): Record<string, unknown> {
  const copy = structuredClone(config) as unknown as Record<string, unknown>;
  for (const role of ["planner", "executor", "verifier"])
    if (plain(copy[role]))
      delete (copy[role] as Record<string, unknown>).apiKey;
  return copy;
}
export function applyClaudeCodeOverride(
  config: ResolvedConfig,
  model = "sonnet",
): ResolvedConfig {
  config.planner = { provider: "claude-code", model };
  config.executor = {
    provider: "claude-code",
    model,
    claudeCode: { dangerouslySkipPermissions: true },
  };
  config.verifier = { provider: "claude-code", model };
  return config;
}
export function printConfig(
  config: ResolvedConfig,
  provenance?: ConfigProvenance,
): string {
  const safe = redactConfig(config);
  const lines = ["Resolved Configuration:", JSON.stringify(safe, null, 2)];
  if (provenance)
    lines.push(
      "",
      "Provenance:",
      ...Object.entries(provenance)
        .sort()
        .map(([key, source]) => `  ${key}: ${source}`),
    );
  return lines.join("\n");
}
