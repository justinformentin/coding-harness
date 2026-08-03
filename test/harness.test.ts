import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  resumeHarness,
  runHarness,
  type HarnessEvent,
} from "../src/harness.js";
import { loadEvents } from "../src/run-store.js";
import { FileRunStore } from "../src/run-store.js";
import { createInitialState } from "../src/state.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { ResolvedConfig, PlannerChecklistItem } from "../src/schemas.js";

const originalCwd = process.cwd();
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  process.chdir(originalCwd);
  for (const server of servers.splice(0)) await server.stop(true);
});

const plannedItem: PlannerChecklistItem = {
  id: "write-greeting",
  description: "Write greeting.txt",
  status: "pending",
  acceptanceCriteria: ["greeting.txt exists"],
  evidenceRequired: ["file"],
  evidenceFound: [],
  dependencies: [],
  assertions: [{ kind: "file_exists", path: "greeting.txt" }],
};

const plannerResponse = JSON.stringify({
  goal: "Create a greeting",
  checklist: [plannedItem],
});

function sse(content: string): Response {
  const data = JSON.stringify({
    choices: [{ delta: { content }, finish_reason: "stop" }],
  });
  return new Response(`data: ${data}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

function fakeProvider(responses: string[]): {
  config: ResolvedConfig;
  requests: () => number;
} {
  let requestCount = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      const response = responses[requestCount++];
      return response === undefined
        ? new Response("fake provider response queue exhausted", {
            status: 500,
          })
        : sse(response);
    },
  });
  servers.push(server);
  const role = {
    provider: "local" as const,
    model: "fake",
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
  };
  return {
    config: {
      ...structuredClone(DEFAULT_CONFIG),
      planner: role,
      executor: role,
      verifier: role,
    },
    requests: () => requestCount,
  };
}

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harness-e2e-"));
  process.chdir(dir);
  return dir;
}

describe("fake-provider harness scenarios", () => {
  test("executes dependency-ordered steps one attempt at a time", async () => {
    const dir = await workspace();
    const first = {
      ...structuredClone(plannedItem),
      id: "first",
      description: "Write first.txt",
      assertions: [{ kind: "file_exists" as const, path: "first.txt" }],
    };
    const second = {
      ...structuredClone(plannedItem),
      id: "second",
      description: "Write second.txt",
      dependencies: ["first"],
      assertions: [{ kind: "file_exists" as const, path: "second.txt" }],
    };
    const provider = fakeProvider([
      JSON.stringify({ goal: "two steps", checklist: [first, second] }),
      '```tool\n{"name":"write_file","arguments":{"path":"first.txt","content":"1"}}\n```\n```tool\n{"name":"finish","completedItems":["first"]}\n```',
      '```tool\n{"name":"write_file","arguments":{"path":"second.txt","content":"2"}}\n```\n```tool\n{"name":"finish","completedItems":["second"]}\n```',
    ]);
    const events: HarnessEvent[] = [];
    const state = await runHarness(
      "Create two files",
      provider.config,
      (event) => events.push(event),
    );

    expect(state.checklist.map((item) => item.status)).toEqual([
      "passed",
      "passed",
    ]);
    expect(state.stepAttempts).toEqual({ first: 1, second: 1 });
    expect(provider.requests()).toBe(3);
    expect(
      events
        .filter((event) => event.type === "executor_start")
        .map((event) => (event.type === "executor_start" ? event.itemId : "")),
    ).toEqual(["first", "second"]);
    await rm(dir, { recursive: true, force: true });
  });

  test("revalidates earlier steps after a later edit regresses them", async () => {
    const dir = await workspace();
    const first = {
      ...structuredClone(plannedItem),
      id: "first",
      assertions: [
        { kind: "file_matches" as const, path: "first.txt", pattern: "one" },
      ],
    };
    const second = {
      ...structuredClone(plannedItem),
      id: "second",
      dependencies: ["first"],
      assertions: [{ kind: "file_exists" as const, path: "second.txt" }],
    };
    const provider = fakeProvider([
      JSON.stringify({
        goal: "preserve regressions",
        checklist: [first, second],
      }),
      '```tool\n{"name":"write_file","arguments":{"path":"first.txt","content":"one"}}\n```\n```tool\n{"name":"finish","completedItems":["first"]}\n```',
      '```tool\n{"name":"write_file","arguments":{"path":"first.txt","content":"broken"}}\n```\n```tool\n{"name":"write_file","arguments":{"path":"second.txt","content":"two"}}\n```\n```tool\n{"name":"finish","completedItems":["second"]}\n```',
      '```tool\n{"name":"write_file","arguments":{"path":"first.txt","content":"one"}}\n```\n```tool\n{"name":"finish","completedItems":["first"]}\n```',
    ]);

    const state = await runHarness(
      "Preserve prior work",
      provider.config,
      () => {},
    );
    expect(state.stepAttempts).toEqual({ first: 2, second: 1 });
    expect(state.checklist.every((item) => item.status === "passed")).toBe(
      true,
    );
    await rm(dir, { recursive: true, force: true });
  });

  test("keeps human review distinct in the canonical final projection", async () => {
    const dir = await workspace();
    const reviewItem = {
      ...structuredClone(plannedItem),
      assertions: [
        { kind: "human_review" as const, instructions: "Inspect the greeting" },
      ],
    };
    const provider = fakeProvider([
      JSON.stringify({ goal: "review", checklist: [reviewItem] }),
      '```tool\n{"name":"finish","completedItems":["write-greeting"]}\n```',
    ]);
    const state = await runHarness(
      "Prepare a review",
      provider.config,
      () => {},
    );
    expect(state.reviewRequired).toEqual(["write-greeting"]);
    expect((await new FileRunStore(state.runId).replay()).status).toBe(
      "awaiting_review",
    );
    await rm(dir, { recursive: true, force: true });
  });

  test("persists evidence-linked model judgments as lower confidence", async () => {
    const dir = await workspace();
    const judgedItem = {
      ...structuredClone(plannedItem),
      assertions: [
        {
          kind: "model_judge" as const,
          rubric: "The output is clear",
          evidenceIds: ["command:0"],
        },
      ],
    };
    const provider = fakeProvider([
      JSON.stringify({ goal: "judge output", checklist: [judgedItem] }),
      '```tool\n{"name":"run_command","arguments":{"command":"echo clear-output"}}\n```\n```tool\n{"name":"finish","completedItems":["write-greeting"]}\n```',
      '{"passed":true,"rationale":"The output is clear","evidenceIds":["command:0"]}',
    ]);
    const state = await runHarness("Judge output", provider.config, () => {});
    expect(state.verifierReport?.assertionResults[0]).toMatchObject({
      kind: "model_judge",
      status: "passed",
      confidence: "model",
      evidenceIds: ["command:0"],
    });
    const verification = (await loadEvents(state.runId)).find(
      (event) => event.type === "verify_complete",
    );
    expect(
      verification?.type === "verify_complete"
        ? verification.report.assertionResults[0]?.confidence
        : undefined,
    ).toBe("model");
    await rm(dir, { recursive: true, force: true });
  });

  test("completes a deterministic task end to end", async () => {
    const dir = await workspace();
    const provider = fakeProvider([
      plannerResponse,
      '```tool\n{"name":"write_file","arguments":{"path":"greeting.txt","content":"hello\\n"}}\n```\n```tool\n{"name":"finish","completedItems":["write-greeting"]}\n```',
    ]);
    const events: HarnessEvent[] = [];

    const state = await runHarness(
      "Create a greeting",
      provider.config,
      (event) => events.push(event),
    );

    expect(state.verifierReport?.done).toBe(true);
    expect(await readFile("greeting.txt", "utf8")).toBe("hello\n");
    expect(events.at(-1)?.type).toBe("complete");
    expect(provider.requests()).toBe(2);
    expect((await loadEvents(state.runId)).at(-1)?.type).toBe("complete");
    const durable = await new FileRunStore(state.runId).readEvents();
    const modelStarts = durable.filter(
      (event) => event.type === "model_call_start",
    );
    const modelEnds = durable.filter(
      (event) => event.type === "model_call_end",
    );
    const toolStarts = durable.filter(
      (event) => event.type === "tool_call_start",
    );
    const toolEnds = durable.filter((event) => event.type === "tool_call_end");
    expect(modelStarts.map((event) => event.spanId).sort()).toEqual(
      modelEnds.map((event) => event.spanId).sort(),
    );
    expect(toolStarts.map((event) => event.spanId).sort()).toEqual(
      toolEnds.map((event) => event.spanId).sort(),
    );
    expect(toolStarts.every((event) => Boolean(event.parentSpanId))).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("persists failed planner parses as artifacts before bounded repair", async () => {
    const dir = await workspace();
    const provider = fakeProvider([
      `Here is the plan: ${plannerResponse}`,
      plannerResponse,
      '```tool\n{"name":"write_file","arguments":{"path":"greeting.txt","content":"hello"}}\n```\n```tool\n{"name":"finish","completedItems":["write-greeting"]}\n```',
    ]);
    const state = await runHarness(
      "Create a greeting",
      provider.config,
      () => {},
    );
    const events = await loadEvents(state.runId);
    const failure = events.find((event) => event.type === "parse_failure");
    expect(failure).toMatchObject({
      type: "parse_failure",
      role: "planner",
      parseAttempt: 1,
    });
    if (failure?.type === "parse_failure")
      expect(
        await readFile(
          join(".runs", state.runId, "artifacts", failure.artifact),
          "utf8",
        ),
      ).toContain("Here is the plan");
    await rm(dir, { recursive: true, force: true });
  });

  test("persists explicit context compaction with an artifact link", async () => {
    const dir = await workspace();
    const provider = fakeProvider([
      plannerResponse,
      '```tool\n{"name":"write_file","arguments":{"path":"scratch.txt","content":"temporary"}}\n```',
      '```tool\n{"name":"write_file","arguments":{"path":"greeting.txt","content":"done"}}\n```\n```tool\n{"name":"finish","completedItems":["write-greeting"]}\n```',
    ]);
    provider.config.context = { maxMessages: 2, maxBytes: 800 };
    const state = await runHarness(
      "Create a greeting",
      provider.config,
      () => {},
    );
    const event = (await loadEvents(state.runId)).find(
      (candidate) => candidate.type === "context_compacted",
    );
    expect(event?.type).toBe("context_compacted");
    if (event?.type === "context_compacted") {
      expect(state.contextArtifacts["write-greeting"]).toContain(
        event.artifact,
      );
      expect(
        await readFile(
          join(".runs", state.runId, "artifacts", event.artifact),
          "utf8",
        ),
      ).toContain("scratch.txt");
    }
    await rm(dir, { recursive: true, force: true });
  });

  test("repairs failed evidence and then succeeds", async () => {
    const dir = await workspace();
    const provider = fakeProvider([
      plannerResponse,
      '```tool\n{"name":"finish","completedItems":["write-greeting"]}\n```',
      '```tool\n{"name":"write_file","arguments":{"path":"greeting.txt","content":"repaired\\n"}}\n```\n```tool\n{"name":"finish","completedItems":["write-greeting"]}\n```',
    ]);
    const events: HarnessEvent[] = [];

    const state = await runHarness(
      "Create a greeting",
      provider.config,
      (event) => events.push(event),
    );

    expect(state.iteration).toBe(2);
    expect(state.verifierReport?.done).toBe(true);
    expect(events.some((event) => event.type === "repair")).toBe(true);
    expect(await readFile("greeting.txt", "utf8")).toBe("repaired\n");
    await rm(dir, { recursive: true, force: true });
  });

  test("stops repeated identical failures with a durable no-progress reason", async () => {
    const dir = await workspace();
    const provider = fakeProvider([
      plannerResponse,
      '```tool\n{"name":"finish","completedItems":["write-greeting"]}\n```',
      '```tool\n{"name":"finish","completedItems":["write-greeting"]}\n```',
    ]);
    provider.config.loop.noProgressAttempts = 1;
    const state = await runHarness(
      "Create a greeting",
      provider.config,
      () => {},
    );
    expect(state.stopReason).toBe("no_progress");
    expect(state.stepAttempts["write-greeting"]).toBe(2);
    const events = await loadEvents(state.runId);
    expect(events.at(-1)).toMatchObject({
      type: "budget_exhausted",
      reason: "no_progress",
    });
    await rm(dir, { recursive: true, force: true });
  });

  test("stops at the configured iteration budget", async () => {
    const dir = await workspace();
    const provider = fakeProvider([
      plannerResponse,
      '```tool\n{"name":"finish","completedItems":["write-greeting"]}\n```',
    ]);
    const events: HarnessEvent[] = [];

    const state = await runHarness(
      "Create a greeting",
      provider.config,
      (event) => events.push(event),
      {
        maxIterations: 1,
      },
    );

    expect(state.verifierReport?.done).toBe(false);
    expect(state.iteration).toBe(1);
    expect(events.at(-1)?.type).toBe("max_iterations");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("cancellation and resume", () => {
  test("an already-cancelled run stops before executing resumed work", async () => {
    const dir = await workspace();
    const provider = fakeProvider([]);
    const state = createInitialState("Create a greeting", 3);
    state.checklist = [structuredClone(plannedItem)];
    const controller = new AbortController();
    controller.abort("test stop");
    const events: HarnessEvent[] = [];

    await resumeHarness(state, provider.config, (event) => events.push(event), {
      signal: controller.signal,
      maxIterations: 3,
    });

    expect(provider.requests()).toBe(0);
    expect(events.map((event) => event.type)).toEqual(["stopped"]);
    await rm(dir, { recursive: true, force: true });
  });

  test("resume preserves work and durable attempt counters", async () => {
    const dir = await workspace();
    const provider = fakeProvider([
      '```tool\n{"name":"write_file","arguments":{"path":"greeting.txt","content":"resumed\\n"}}\n```\n```tool\n{"name":"finish","completedItems":["write-greeting"]}\n```',
    ]);
    const state = createInitialState("Create a greeting", 1);
    state.checklist = [structuredClone(plannedItem)];
    state.iteration = 1;
    state.messages.push({ role: "user", content: state.originalPrompt });
    await mkdir(join(".runs", state.runId), { recursive: true });

    const resumed = await resumeHarness(state, provider.config, () => {}, {
      maxIterations: 2,
    });

    expect(resumed.iteration).toBe(2);
    expect(resumed.verifierReport?.done).toBe(true);
    expect(await readFile("greeting.txt", "utf8")).toBe("resumed\n");
    await rm(dir, { recursive: true, force: true });
  });
});
