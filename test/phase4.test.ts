import { afterEach, describe, expect, test } from "bun:test";
import { chat } from "../src/llm.js";
import { buildStepContext } from "../src/context.js";
import { ModelError, retryModelCall } from "../src/model-retry.js";
import { judgeWithModel } from "../src/model-judge.js";
import { createInitialState } from "../src/state.js";
import { verifyStepAssertions } from "../src/assertion-verifier.js";
import { parsePlannerOutput } from "../src/planner.js";
import type { ModelTrace, PlannerChecklistItem } from "../src/schemas.js";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

function server(fetch: (request: Request) => Response): string {
  const instance = Bun.serve({ port: 0, fetch });
  servers.push(instance);
  return `http://127.0.0.1:${instance.port}`;
}

function sse(events: Array<Record<string, unknown> | "[DONE]">): Response {
  return new Response(
    events
      .map((event) =>
        event === "[DONE]"
          ? "data: [DONE]\n\n"
          : `data: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

describe("normalized provider contracts", () => {
  test("normalizes OpenAI text, native tools, usage, stop reason, and trace", async () => {
    const traces: ModelTrace[] = [];
    const baseUrl = server(() =>
      sse([
        { choices: [{ delta: { content: "hello " } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    function: { name: "write_file", arguments: '{"path":' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                content: "world",
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '"a.txt","content":"ok"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
        {
          choices: [],
          usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
        },
        "[DONE]",
      ]),
    );
    const result = await chat(
      { provider: "openai", model: "fake", baseUrl, apiKey: "test" },
      "system",
      [{ role: "user", content: "go" }],
      { onTrace: (trace) => traces.push(trace) },
    );
    expect(result).toMatchObject({
      text: "hello world",
      stopReason: "tool_use",
      usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
      toolCalls: [
        {
          id: "call-1",
          name: "write_file",
          arguments: { path: "a.txt", content: "ok" },
        },
      ],
    });
    expect(traces.map((trace) => trace.phase)).toEqual(["start", "end"]);
    expect(traces[0]?.spanId).toBe(traces[1]?.spanId);
  });

  test("normalizes Anthropic native tool blocks and token usage", async () => {
    const baseUrl = server(
      () =>
        new Response(
          [
            'event: message_start\ndata: {"message":{"usage":{"input_tokens":3}}}\n\n',
            'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"inspect"}}\n\n',
            'event: content_block_start\ndata: {"index":1,"content_block":{"type":"tool_use","id":"tool-1","name":"read_file","input":{}}}\n\n',
            'event: content_block_delta\ndata: {"index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"}}\n\n',
            'event: message_delta\ndata: {"delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}\n\n',
            "event: message_stop\ndata: {}\n\n",
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const result = await chat(
      { provider: "anthropic", model: "fake", baseUrl, apiKey: "test" },
      "system",
      [{ role: "user", content: "go" }],
    );
    expect(result).toMatchObject({
      text: "inspect",
      stopReason: "tool_use",
      usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
      toolCalls: [
        { id: "tool-1", name: "read_file", arguments: { path: "a.ts" } },
      ],
    });
  });
});

describe("retry and structured repair", () => {
  test("retries transient errors with jitter but never retries policy errors", async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const value = await retryModelCall(
      async () => {
        attempts++;
        if (attempts < 3) throw new ModelError("busy", "transient");
        return "ok";
      },
      { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
      {
        random: () => 0.5,
        sleep: async (milliseconds) => void sleeps.push(milliseconds),
      },
    );
    expect(value).toBe("ok");
    expect(sleeps).toEqual([5, 10]);

    let policyAttempts = 0;
    await expect(
      retryModelCall(async () => {
        policyAttempts++;
        throw new ModelError("denied", "policy");
      }),
    ).rejects.toThrow("denied");
    expect(policyAttempts).toBe(1);
  });

  test("repairs model-judge JSON and enforces evidence IDs", async () => {
    let requests = 0;
    const failures: string[] = [];
    const baseUrl = server(() =>
      sse([
        {
          choices: [
            {
              delta: {
                content:
                  requests++ === 0
                    ? "not json"
                    : '{"passed":true,"rationale":"clear","evidenceIds":["file:a.md"]}',
              },
              finish_reason: "stop",
            },
          ],
        },
        "[DONE]",
      ]),
    );
    const result = await judgeWithModel(
      { provider: "local", model: "fake", baseUrl },
      { rubric: "Clear prose", evidence: { "file:a.md": "Readable text" } },
      { onParseFailure: async (failure) => void failures.push(failure.error) },
    );
    expect(result).toEqual({
      passed: true,
      rationale: "clear",
      evidenceIds: ["file:a.md"],
      confidence: "model",
    });
    expect(failures).toHaveLength(1);
  });

  test("rejects broad JSON extraction and surfaces model confidence", async () => {
    expect(
      parsePlannerOutput('Here is a plan: {"goal":"x","checklist":[]}').ok,
    ).toBe(false);
    const state = createInitialState("judge");
    state.artifacts.commandOutputs.push("Readable text");
    const item: PlannerChecklistItem = {
      id: "judge",
      description: "Judge prose",
      status: "verifying",
      acceptanceCriteria: ["clear"],
      evidenceRequired: ["command output"],
      evidenceFound: [],
      dependencies: [],
      assertions: [
        {
          kind: "model_judge",
          rubric: "Clear prose",
          evidenceIds: ["command:0"],
        },
      ],
    };
    const verification = await verifyStepAssertions(
      item,
      state,
      process.cwd(),
      1000,
      1000,
      async ({ evidence }) => ({
        passed: true,
        rationale: evidence["command:0"],
        evidenceIds: ["command:0"],
        confidence: "model",
      }),
    );
    expect(verification.assertions[0]).toMatchObject({
      status: "passed",
      confidence: "model",
      evidenceIds: ["command:0"],
    });
  });
});

describe("bounded per-step context", () => {
  test("compacts oldest history and never exceeds message or byte limits", () => {
    const state = createInitialState("ship the feature");
    const item: PlannerChecklistItem = {
      id: "build",
      description: "Build it",
      status: "executing",
      acceptanceCriteria: ["works"],
      evidenceRequired: ["tests"],
      evidenceFound: [],
      dependencies: [],
      assertions: [{ kind: "file_exists", path: "out.txt" }],
    };
    state.stepMessages.build = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 ? ("tool" as const) : ("assistant" as const),
      content: `history-${index}-${"x".repeat(80)}`,
    }));
    const view = buildStepContext(state, item, {
      maxMessages: 3,
      maxBytes: 420,
    });
    expect(view.messages.length).toBeLessThanOrEqual(3);
    expect(view.byteLength).toBeLessThanOrEqual(420);
    expect(view.compacted.length).toBeGreaterThan(0);
    expect(view.retainedHistory.at(-1)?.content).toContain("history-7");
  });
});
