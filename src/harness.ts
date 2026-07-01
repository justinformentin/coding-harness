import { plan } from "./planner.js";
import { executeToCompletion } from "./executor.js";
import { verify } from "./verifier.js";
import { repairPrompt } from "./prompts.js";
import { createInitialState } from "./state.js";
import {
  saveRunInit,
  saveChecklist,
  savePlanMarkdown,
  saveStateCheckpoint,
  appendIteration,
  appendVerifierReport,
} from "./run-store.js";
import type {
  HarnessState,
  ModelConfig,
  PlannerChecklistItem,
  VerifierReport,
} from "./schemas.js";

export type HarnessEvent =
  | { type: "plan_start" }
  | { type: "plan_complete"; itemCount: number }
  | {
      type: "plan_review";
      planPath: string;
      checklist: PlannerChecklistItem[];
    }
  | { type: "plan_approved" }
  | { type: "plan_rejected" }
  | {
      type: "iteration_start";
      iteration: number;
      // undefined = no cap (loop runs until the verifier is satisfied)
      maxIterations: number | undefined;
    }
  | { type: "steering"; message: string }
  | { type: "executor_start"; itemId: string; itemDescription: string }
  | { type: "executor_token"; token: string }
  | { type: "executor_tool"; name: string; detail?: string }
  | { type: "executor_complete"; response: string; toolCalls: number }
  | { type: "tool_result"; name: string; success: boolean; output: string }
  | { type: "verify_start" }
  | { type: "verify_complete"; report: VerifierReport; runId: string }
  | { type: "repair"; instruction: string; runId: string }
  | { type: "complete"; state: HarnessState }
  | { type: "max_iterations"; state: HarnessState }
  | { type: "error"; message: string };

export type EventCallback = (event: HarnessEvent) => void;

// Pull a short, human-readable detail out of a tool's input so the log line
// reads "Edit src/foo.ts" rather than just "Edit". Falls back to nothing.
function toolDetail(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  const candidate =
    o.file_path ?? o.path ?? o.command ?? o.pattern ?? o.url ?? o.description;
  if (typeof candidate !== "string") return undefined;
  const trimmed = candidate.trim().replace(/\s+/g, " ");
  return trimmed.length > 80 ? trimmed.slice(0, 80) + "…" : trimmed;
}

export type HarnessOptions = {
  // Hard cap on the execute/verify loop. Omitted = no limit: the loop runs
  // until the verifier reports done. A limit is only applied when the caller
  // explicitly sets one (--max-iterations flag, HARNESS_MAX_ITERATIONS env, or
  // maxIterations in .harness.json).
  maxIterations?: number;
  onPlanReview?: (
    planPath: string,
    checklist: PlannerChecklistItem[]
  ) => Promise<"approve" | "reject">;
  // Pulled at the top of each iteration to inject mid-run "steering" messages
  // the user typed while the loop was running. Returns the queued messages and
  // is expected to clear the queue. They are appended to the executor
  // conversation as user turns before the next execute step.
  drainSteering?: () => string[];
};

// Append any queued steering messages to the conversation as user turns and
// surface each one to the UI. Called at the start of every iteration so
// follow-ups the user typed mid-run take effect on the next execute step.
function applySteering(
  state: HarnessState,
  onEvent: EventCallback,
  drainSteering?: () => string[]
): void {
  const pending = drainSteering?.() ?? [];
  for (const message of pending) {
    state.messages.push({ role: "user", content: message });
    onEvent({ type: "steering", message });
  }
}

export async function runHarness(
  prompt: string,
  config: ModelConfig,
  onEvent: EventCallback,
  options?: HarnessOptions | number
): Promise<HarnessState> {
  // Support legacy numeric fourth argument for backward compatibility
  const opts: HarnessOptions =
    typeof options === "number" ? { maxIterations: options } : options ?? {};
  // The cap is honored only when the caller explicitly sets one. Otherwise it
  // stays undefined and the loop runs until the verifier is satisfied.
  const maxIterations =
    typeof options === "number" ? options : opts.maxIterations;

  const state = createInitialState(prompt, maxIterations);

  try {
    // Save initial run data
    await saveRunInit(state, config);

    // Plan
    onEvent({ type: "plan_start" });
    state.checklist = await plan(prompt, config.planner);
    await saveChecklist(state);

    onEvent({ type: "plan_complete", itemCount: state.checklist.length });

    // Save plan as readable markdown and show it for review
    const planPath = await savePlanMarkdown(state);
    onEvent({ type: "plan_review", planPath, checklist: state.checklist });

    // If an approval callback is provided, wait for approval
    if (opts.onPlanReview) {
      const decision = await opts.onPlanReview(planPath, state.checklist);
      if (decision === "reject") {
        onEvent({ type: "plan_rejected" });
        return state;
      }
      onEvent({ type: "plan_approved" });
    }

    // Add initial user message for executor conversation
    state.messages.push({ role: "user", content: prompt });

    // Main loop. Runs until the verifier reports done, or — when a cap is set —
    // until that many iterations have run.
    while (
      state.maxIterations === undefined ||
      state.iteration < state.maxIterations
    ) {
      state.iteration++;
      onEvent({
        type: "iteration_start",
        iteration: state.iteration,
        maxIterations: state.maxIterations,
      });

      // Inject any mid-run steering the user queued while we were busy
      applySteering(state, onEvent, opts.drainSteering);

      // Execute to completion — the executor runs every outstanding item / turn
      // before returning, so the verifier below sees a finished attempt rather
      // than firing after each small step. Per-item progress is surfaced via
      // onItemStart. Tokens and tool uses stream to the TUI in real time.
      const result = await executeToCompletion(state, config.executor, {
        onToken: (token) => onEvent({ type: "executor_token", token }),
        onToolUse: (use) =>
          onEvent({
            type: "executor_tool",
            name: use.name,
            detail: toolDetail(use.input),
          }),
        onItemStart: (item) =>
          onEvent({
            type: "executor_start",
            itemId: item.id,
            itemDescription: item.description,
          }),
      });
      onEvent({
        type: "executor_complete",
        response: result.response,
        toolCalls: result.toolCalls.length,
      });

      // Report tool results
      for (const tr of result.toolResults) {
        onEvent({
          type: "tool_result",
          name: tr.name,
          success: tr.success,
          output: tr.output,
        });
      }

      // Verify
      onEvent({ type: "verify_start" });
      const report = await verify(state, config.verifier);
      state.verifierReport = report;
      await appendVerifierReport(state, report);
      onEvent({ type: "verify_complete", report, runId: state.runId });

      // Update checklist statuses based on verifier report
      for (const itemId of report.completedItems) {
        const item = state.checklist.find((i) => i.id === itemId);
        if (item) item.status = "done";
      }

      // Save checkpoint
      await appendIteration(state, {
        executorResponse: result.response.slice(0, 1000),
        toolCalls: result.toolCalls.length,
        verifierDone: report.done,
      });
      await saveStateCheckpoint(state);

      if (report.done) {
        onEvent({ type: "complete", state });
        return state;
      }

      // Repair prompt
      const repair = repairPrompt(report);
      state.messages.push({ role: "user", content: repair });
      onEvent({
        type: "repair",
        instruction: report.nextInstruction,
        runId: state.runId,
      });
    }

    // Max iterations reached
    onEvent({ type: "max_iterations", state });
    await saveStateCheckpoint(state);
    return state;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    onEvent({ type: "error", message: msg });
    await saveStateCheckpoint(state).catch(() => {});
    throw e;
  }
}

export async function resumeHarness(
  state: HarnessState,
  config: ModelConfig,
  onEvent: EventCallback,
  options?: Pick<HarnessOptions, "drainSteering" | "maxIterations">
): Promise<HarnessState> {
  // Reset iteration counter to allow more attempts.
  state.iteration = 0;
  // Re-derive the cap from current explicit sources rather than trusting the
  // (possibly stale) value saved with the run. With no explicit cap this is
  // undefined, so the resumed run is unbounded too.
  state.maxIterations = options?.maxIterations;
  return runHarnessLoop(state, config, onEvent, options);
}

async function runHarnessLoop(
  state: HarnessState,
  config: ModelConfig,
  onEvent: EventCallback,
  options?: Pick<HarnessOptions, "drainSteering" | "maxIterations">
): Promise<HarnessState> {
  while (
    state.maxIterations === undefined ||
    state.iteration < state.maxIterations
  ) {
    state.iteration++;
    onEvent({
      type: "iteration_start",
      iteration: state.iteration,
      maxIterations: state.maxIterations,
    });

    // Inject any mid-run steering the user queued while we were busy
    applySteering(state, onEvent, options?.drainSteering);

    // Execute to completion before verifying (see runHarness for rationale).
    const result = await executeToCompletion(state, config.executor, {
      onToken: (token) => onEvent({ type: "executor_token", token }),
      onToolUse: (use) =>
        onEvent({
          type: "executor_tool",
          name: use.name,
          detail: toolDetail(use.input),
        }),
      onItemStart: (item) =>
        onEvent({
          type: "executor_start",
          itemId: item.id,
          itemDescription: item.description,
        }),
    });
    onEvent({
      type: "executor_complete",
      response: result.response,
      toolCalls: result.toolCalls.length,
    });

    for (const tr of result.toolResults) {
      onEvent({
        type: "tool_result",
        name: tr.name,
        success: tr.success,
        output: tr.output,
      });
    }

    onEvent({ type: "verify_start" });
    const report = await verify(state, config.verifier);
    state.verifierReport = report;
    await appendVerifierReport(state, report);
    onEvent({ type: "verify_complete", report, runId: state.runId });

    for (const itemId of report.completedItems) {
      const item = state.checklist.find((i) => i.id === itemId);
      if (item) item.status = "done";
    }

    await appendIteration(state, {
      executorResponse: result.response.slice(0, 1000),
      toolCalls: result.toolCalls.length,
      verifierDone: report.done,
    });
    await saveStateCheckpoint(state);

    if (report.done) {
      onEvent({ type: "complete", state });
      return state;
    }

    const repair = repairPrompt(report);
    state.messages.push({ role: "user", content: repair });
    onEvent({
      type: "repair",
      instruction: report.nextInstruction,
      runId: state.runId,
    });
  }

  onEvent({ type: "max_iterations", state });
  return state;
}
