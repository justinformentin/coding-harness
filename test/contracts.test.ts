import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { ConfigError, resolveConfig } from "../src/config.js";
import { validatePlan, PlanSchema } from "../src/contracts/plan.js";
import { RunEventSchema } from "../src/contracts/events.js";
import { RunResultSchema } from "../src/contracts/result.js";
import { saveRunInit } from "../src/run-store.js";
import { createInitialState } from "../src/state.js";

const originalCwd = process.cwd();
const dirs: string[] = [];
afterEach(async () => {
  process.chdir(originalCwd);
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "harness-contracts-"));
  dirs.push(dir);
  return dir;
}

describe("resolved configuration contract", () => {
  test("resolves default, user, project, environment, and CLI layers with provenance", async () => {
    const dir = await workspace();
    const user = join(dir, "user.json");
    const project = join(dir, ".harness.json");
    await writeFile(
      user,
      JSON.stringify({ schemaVersion: 1, planner: { model: "user" } }),
    );
    await writeFile(
      project,
      JSON.stringify({
        schemaVersion: 1,
        planner: { model: "project" },
        executor: { model: "project-executor" },
      }),
    );
    const loaded = await resolveConfig({
      cwd: dir,
      userConfigPath: user,
      projectConfigPath: project,
      env: { HARNESS_PLANNER_MODEL: "env" },
      cli: { planner: { model: "cli" } },
    });
    expect(loaded.config.planner.model).toBe("cli");
    expect(loaded.config.executor.model).toBe("project-executor");
    expect(loaded.provenance["planner.model"]).toBe("cli");
    expect(loaded.provenance["loop.maxModelCalls"]).toBe("default");
  });

  test("reports strict field-level errors rather than falling back", async () => {
    const dir = await workspace();
    const project = join(dir, ".harness.json");
    await writeFile(
      project,
      JSON.stringify({
        schemaVersion: 1,
        surprise: true,
        loop: { maxModelCalls: 0 },
      }),
    );
    await expect(
      resolveConfig({
        cwd: dir,
        userConfigPath: join(dir, "none"),
        projectConfigPath: project,
        env: {},
      }),
    ).rejects.toBeInstanceOf(ConfigError);
    try {
      await resolveConfig({
        cwd: dir,
        userConfigPath: join(dir, "none"),
        projectConfigPath: project,
        env: {},
      });
    } catch (error) {
      expect(String(error)).toContain("surprise");
      expect(String(error)).toContain("loop.maxModelCalls");
    }
  });

  test("rejects invalid environment values", async () => {
    const dir = await workspace();
    await expect(
      resolveConfig({
        cwd: dir,
        userConfigPath: join(dir, "none"),
        env: { HARNESS_EXECUTOR_PROVIDER: "invented" },
      }),
    ).rejects.toThrow("executor.provider");
    await expect(
      resolveConfig({
        cwd: dir,
        userConfigPath: join(dir, "none"),
        env: { HARNESS_MAX_ITERATIONS: "not-a-number" },
      }),
    ).rejects.toThrow("maxIterations");
  });

  test("rejects unversioned files and never persists credentials", async () => {
    const dir = await workspace();
    process.chdir(dir);
    await writeFile(
      ".harness.json",
      JSON.stringify({ planner: { model: "unversioned" } }),
    );
    await expect(
      resolveConfig({ cwd: dir, userConfigPath: join(dir, "none"), env: {} }),
    ).rejects.toThrow("schemaVersion must be 1");
    await writeFile(
      ".harness.json",
      JSON.stringify({
        schemaVersion: 1,
        planner: {
          provider: "openai",
          model: "configured",
          apiKeyEnv: "TEST_SECRET",
        },
      }),
    );
    const loaded = await resolveConfig({
      cwd: dir,
      userConfigPath: join(dir, "none"),
      env: { TEST_SECRET: "top-secret" },
    });
    expect(loaded.config.planner.apiKey).toBe("top-secret");
    const state = createInitialState("secret test");
    await saveRunInit(state, loaded.config);
    const persisted = await readFile(
      join(".runs", state.runId, "config.resolved.json"),
      "utf8",
    );
    expect(persisted).not.toContain("top-secret");
    expect(persisted).not.toContain('"apiKey"');
    expect(persisted).toContain("TEST_SECRET");
  });
});

describe("versioned domain contracts", () => {
  const valid = {
    schemaVersion: 1 as const,
    goal: "ship phase",
    steps: [
      {
        id: "build",
        description: "Build it",
        dependsOn: [],
        verify: [{ kind: "file_exists" as const, path: "src/new.ts" }],
      },
    ],
  };
  test("accepts a well-formed plan and rejects duplicates, missing dependencies, cycles, paths, and regexes", () => {
    expect(validatePlan(valid).steps).toHaveLength(1);
    expect(() =>
      validatePlan({ ...valid, steps: [valid.steps[0], valid.steps[0]] }),
    ).toThrow("Duplicate");
    expect(() =>
      validatePlan({
        ...valid,
        steps: [{ ...valid.steps[0], dependsOn: ["missing"] }],
      }),
    ).toThrow("Unknown dependency");
    expect(() =>
      validatePlan({
        ...valid,
        steps: [{ ...valid.steps[0], dependsOn: ["build"] }],
      }),
    ).toThrow("Cyclic");
    expect(
      PlanSchema.safeParse({
        ...valid,
        steps: [
          {
            ...valid.steps[0],
            verify: [{ kind: "file_exists", path: "../secret" }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(() =>
      validatePlan({
        ...valid,
        steps: [
          {
            ...valid.steps[0],
            verify: [{ kind: "file_matches", path: "src/a.ts", pattern: "[" }],
          },
        ],
      }),
    ).toThrow("Invalid regular expression");
  });
  test("validates canonical event and result envelopes", () => {
    expect(
      RunEventSchema.parse({
        schemaVersion: 1,
        eventId: "e1",
        sequence: 0,
        timestamp: new Date().toISOString(),
        runId: "r1",
        type: "created",
        data: {},
      }).type,
    ).toBe("created");
    expect(
      RunResultSchema.parse({
        schemaVersion: 1,
        runId: "r1",
        status: "succeeded",
        stopReason: "completed",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        passedSteps: ["build"],
        failedSteps: [],
      }).status,
    ).toBe("succeeded");
  });
});
