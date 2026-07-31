import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig } from "../src/config.js";
import { parsePlannerOutput } from "../src/planner.js";
import { parseToolCalls } from "../src/executor.js";
import { verify } from "../src/verifier.js";
import { FileRunStore, loadEvents } from "../src/run-store.js";
import { createInitialState } from "../src/state.js";
import type { HarnessState, PlannerChecklistItem } from "../src/schemas.js";

const originalCwd = process.cwd();
const envKeys = [
  "HARNESS_PLANNER_MODEL",
  "HARNESS_EXECUTOR_PROVIDER",
  "HARNESS_MAX_ITERATIONS",
] as const;

afterEach(() => {
  process.chdir(originalCwd);
  for (const key of envKeys) delete process.env[key];
});

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "harness-test-"));
}

function item(
  overrides: Partial<PlannerChecklistItem> = {},
): PlannerChecklistItem {
  return {
    id: "step-1",
    description: "Create output",
    status: "in_progress",
    acceptanceCriteria: ["output exists"],
    evidenceRequired: ["file"],
    evidenceFound: [],
    ...overrides,
  };
}

function state(checklist: PlannerChecklistItem[]): HarnessState {
  return { ...createInitialState("fixture", 2), checklist };
}

describe("configuration", () => {
  test("project config overrides defaults and environment overrides project", async () => {
    const dir = await tempWorkspace();
    process.chdir(dir);
    await writeFile(
      ".harness.json",
      JSON.stringify({
        schemaVersion: 1,
        planner: { provider: "local", model: "project-planner" },
        executor: { provider: "local", model: "project-executor" },
        verifier: { provider: "local", model: "project-verifier" },
        maxIterations: 4,
      }),
    );
    process.env.HARNESS_PLANNER_MODEL = "environment-planner";
    process.env.HARNESS_MAX_ITERATIONS = "7";

    const config = await loadConfig();
    expect(config.planner.model).toBe("environment-planner");
    expect(config.executor.model).toBe("project-executor");
    expect(config.maxIterations).toBe(7);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("parsers", () => {
  test("accepts the committed planner fixture", async () => {
    const content = await readFile(
      join(originalCwd, "test/fixtures/planner/valid.json"),
      "utf8",
    );
    const result = parsePlannerOutput(content);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.checklist[0]?.id).toBe("write-greeting");
  });

  test("rejects an invalid plan and skips malformed tool blocks", () => {
    expect(parsePlannerOutput('{"goal":"missing checklist"}').ok).toBe(false);
    const calls = parseToolCalls(
      [
        '```tool\n{"name":"write_file","arguments":{"path":"a.txt","content":"ok"}}\n```',
        "```tool\nnot-json\n```",
        '```tool\n{"name":"finish","completedItems":["step-1"]}\n```',
      ].join("\n"),
    );
    expect(calls).toEqual([
      { name: "write_file", arguments: { path: "a.txt", content: "ok" } },
      { name: "finish", arguments: { completedItems: ["step-1"] } },
    ]);
  });
});

describe("deterministic verification", () => {
  test("passes recorded file, command, pattern, and output evidence", async () => {
    const dir = await tempWorkspace();
    process.chdir(dir);
    await writeFile("output.txt", "hello modern harness\n");
    const s = state([
      item({
        verificationKind: "deterministic",
        verifierConfig: {
          requiredFiles: ["output.txt"],
          requiredCommands: ["bun test"],
          requiredPatterns: ["modern harness"],
          forbiddenPatterns: ["FIXME"],
          successIndicators: ["tests passed"],
        },
      }),
    ]);
    s.artifacts = {
      filesChanged: ["output.txt"],
      commandsRun: ["bun test"],
      commandOutputs: ["tests passed"],
    };
    const report = await verify(s, { provider: "local", model: "unused" });
    expect(report.done).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("does not treat an executor claim as deterministic proof", async () => {
    const s = state([
      item({
        verificationKind: "deterministic",
        verifierConfig: { requiredFiles: ["missing.txt"] },
      }),
    ]);
    s.executorClaims.push("step-1");
    const report = await verify(s, { provider: "local", model: "unused" });
    expect(report.done).toBe(false);
    expect(report.missingEvidence[0]).toContain("File not found");
  });
});

describe("event persistence", () => {
  test("ignores a partial final event line", async () => {
    const dir = await tempWorkspace();
    process.chdir(dir);
    await mkdir(".runs/partial", { recursive: true });
    const store = new FileRunStore("partial");
    await store.append({ type: "plan_start", data: {} });
    await writeFile(
      ".runs/partial/events.jsonl",
      `${await readFile(".runs/partial/events.jsonl", "utf8")}{"event":`,
    );
    expect(await loadEvents("partial")).toEqual([{ type: "plan_start" }]);
    await rm(dir, { recursive: true, force: true });
  });

  test("replays independently written stores and rebuilds an atomic checkpoint", async () => {
    const dir = await tempWorkspace();
    process.chdir(dir);
    const first = new FileRunStore("first");
    const second = new FileRunStore("second");
    await Promise.all([
      first.append({ type: "plan_start", data: {} }),
      second.append({ type: "plan_start", data: {} }),
    ]);
    await first.append({ type: "iteration_start", data: { iteration: 1 } });
    const projection = await first.replay();
    expect(projection.lastSequence).toBe(1);
    expect(projection.iteration).toBe(1);
    expect((await second.replay()).lastSequence).toBe(0);
    await first.writeCheckpoint(projection);
    expect(
      JSON.parse(await readFile(".runs/first/checkpoint.json", "utf8")),
    ).toEqual(projection);
    await rm(dir, { recursive: true, force: true });
  });

  test("stores content-addressed artifacts and repairs only a partial tail", async () => {
    const dir = await tempWorkspace();
    process.chdir(dir);
    const store = new FileRunStore("repairable");
    const hash = await store.putArtifact("model output");
    expect(await readFile(`.runs/repairable/artifacts/${hash}`, "utf8")).toBe(
      "model output",
    );
    await store.append({ type: "plan_start", data: {} });
    await writeFile(
      ".runs/repairable/events.jsonl",
      `${await readFile(".runs/repairable/events.jsonl", "utf8")}{"broken":`,
    );
    expect(await store.repairPartialTail()).toBe(true);
    expect(await store.readEvents()).toHaveLength(1);
    await rm(dir, { recursive: true, force: true });
  });
});
