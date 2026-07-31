import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { DEFAULT_CONFIG } from "../src/config.js";
import { verifyStepAssertions } from "../src/assertion-verifier.js";
import { DeterministicRunController } from "../src/run-controller.js";
import { DependencyScheduler, blockedSteps } from "../src/scheduler.js";
import { createInitialState } from "../src/state.js";
import type { PlannerChecklistItem } from "../src/schemas.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function step(id: string, dependencies: string[] = []): PlannerChecklistItem {
  return {
    id,
    description: id,
    status: "pending",
    acceptanceCriteria: ["verified"],
    evidenceRequired: ["assertion"],
    evidenceFound: [],
    dependencies,
    assertions: [{ kind: "file_exists", path: `${id}.txt` }],
  };
}

describe("dependency scheduler", () => {
  test("selects exactly one ready step and reports blocked dependents", () => {
    const first = step("first");
    const second = step("second", ["first"]);
    const scheduler = new DependencyScheduler();
    expect(scheduler.next([first, second])?.id).toBe("first");
    expect(blockedSteps([first, second])).toEqual(["second"]);
    first.status = "passed";
    expect(scheduler.next([first, second])?.id).toBe("second");
  });
});

describe("source-bound assertions", () => {
  test("binds stdout to an exact argv command and safely reports bad regex", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-phase3-"));
    directories.push(directory);
    await writeFile(join(directory, "value.txt"), "hello\n");
    const item = step("assertions");
    item.assertions = [
      { kind: "file_matches", path: "value.txt", pattern: "hello" },
      {
        kind: "command",
        argv: [process.execPath, "-e", "console.log('bound output')"],
        exitCode: 0,
      },
      { kind: "stdout", from: "assertion:1", contains: "bound output" },
      { kind: "file_matches", path: "value.txt", pattern: "[" },
    ];
    const state = createInitialState("verify");
    const result = await verifyStepAssertions(item, state, directory);
    expect(
      result.assertions.slice(0, 3).every((value) => value.status === "passed"),
    ).toBe(true);
    expect(result.assertions[3]?.actual).toContain("invalid regex");
    expect(result.status).toBe("failed");
  });

  test("a completion claim cannot pass deterministic evidence and human review stays distinct", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-phase3-"));
    directories.push(directory);
    const state = createInitialState("verify");
    state.executorClaims.push("claim");
    const claimed = step("claim");
    expect((await verifyStepAssertions(claimed, state, directory)).status).toBe(
      "failed",
    );
    claimed.assertions = [{ kind: "human_review", instructions: "Inspect it" }];
    expect((await verifyStepAssertions(claimed, state, directory)).status).toBe(
      "human_review",
    );
  });
});

describe("finite durable budgets", () => {
  test("maps cancellation, deadline, attempt, model, and tool limits to stop reasons", () => {
    const cases = [
      [
        "cancelled",
        (
          state: ReturnType<typeof createInitialState>,
          signal: AbortController,
        ) => signal.abort(),
      ],
      [
        "deadline",
        (state: ReturnType<typeof createInitialState>) => (state.startedAt = 0),
      ],
      [
        "max_attempts",
        (state: ReturnType<typeof createInitialState>) =>
          (state.stepAttempts.work = DEFAULT_CONFIG.loop.maxAttemptsPerStep),
      ],
      [
        "max_model_calls",
        (state: ReturnType<typeof createInitialState>) =>
          (state.modelCalls = DEFAULT_CONFIG.loop.maxModelCalls),
      ],
      [
        "max_tool_calls",
        (state: ReturnType<typeof createInitialState>) =>
          (state.toolCalls = DEFAULT_CONFIG.loop.maxToolCalls),
      ],
    ] as const;
    for (const [expected, arrange] of cases) {
      const state = createInitialState("budget");
      const signal = new AbortController();
      arrange(state, signal);
      expect(
        new DeterministicRunController(
          state,
          structuredClone(DEFAULT_CONFIG),
        ).beforeAttempt("work", signal.signal),
      ).toBe(expected);
    }
  });

  test("persists counters and stops repeated identical failures", () => {
    const state = createInitialState("progress");
    const config = structuredClone(DEFAULT_CONFIG);
    config.loop.noProgressAttempts = 1;
    const controller = new DeterministicRunController(state, config);
    const observation = {
      stepId: "work",
      modelCalls: 1,
      toolCalls: 2,
      failures: ["same"],
      workspaceDiff: "",
    };
    expect(controller.recordAttempt(observation)).toBeUndefined();
    expect(controller.recordAttempt(observation)).toBe("no_progress");
    expect(state.stepAttempts.work).toBe(2);
    expect(state.modelCalls).toBe(2);
    expect(state.toolCalls).toBe(4);
  });
});
