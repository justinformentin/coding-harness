import { plan } from "./planner.js";
import { execute } from "./executor.js";
import { verify } from "./verifier.js";
import { repairPrompt } from "./prompts.js";
import { createInitialState, getNextPendingItem } from "./state.js";
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
  | { type: "iteration_start"; iteration: number; maxIterations: number }
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

// Default iteration budget when the caller doesn't pin one. After planning we
// scale up to ~3 iterations per checklist item so larger plans get room to
// finish (each item may need an execute + a repair cycle or two).
const DEFAULT_MAX_ITERATIONS = 25;
const ITERATIONS_PER_ITEM = 3;

export type HarnessOptions = {
  maxIterations?: number;
  onPlanReview?: (
    planPath: string,
    checklist: PlannerChecklistItem[]
  ) => Promise<"approve" | "reject">;
};

export async function runHarness(
  prompt: string,
  config: ModelConfig,
  onEvent: EventCallback,
  options?: HarnessOptions | number
): Promise<HarnessState> {
  // Support legacy numeric fourth argument for backward compatibility
  const opts: HarnessOptions =
    typeof options === "number" ? { maxIterations: options } : options ?? {};
  // An explicit value (CLI flag / legacy arg) is a hard ceiling. When omitted,
  // we start from a generous default and then scale to the plan size below, so
  // a slow model working item-by-item doesn't exhaust the budget mid-task.
  const explicitMax =
    typeof options === "number" ? options : opts.maxIterations;
  const maxIterations = explicitMax ?? DEFAULT_MAX_ITERATIONS;

  const state = createInitialState(prompt, maxIterations);

  try {
    // Save initial run data
    await saveRunInit(state, config);

    // Plan
    onEvent({ type: "plan_start" });
    state.checklist = await plan(prompt, config.planner);
    await saveChecklist(state);

    // Scale the iteration budget to the plan size unless the caller pinned one.
    if (explicitMax === undefined) {
      state.maxIterations = Math.max(
        DEFAULT_MAX_ITERATIONS,
        state.checklist.length * ITERATIONS_PER_ITEM
      );
    }

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

    // Main loop
    while (state.iteration < state.maxIterations) {
      state.iteration++;
      onEvent({
        type: "iteration_start",
        iteration: state.iteration,
        maxIterations: state.maxIterations,
      });

      // Find next item to work on
      const nextItem = getNextPendingItem(state);
      if (nextItem) {
        onEvent({
          type: "executor_start",
          itemId: nextItem.id,
          itemDescription: nextItem.description,
        });
      }

      // Execute — stream tokens and tool uses to the TUI in real time
      const result = await execute(state, config.executor, {
        onToken: (token) => onEvent({ type: "executor_token", token }),
        onToolUse: (use) =>
          onEvent({
            type: "executor_tool",
            name: use.name,
            detail: toolDetail(use.input),
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
  onEvent: EventCallback
): Promise<HarnessState> {
  // Reset iteration counter to allow more attempts
  state.iteration = 0;
  return runHarnessLoop(state, config, onEvent);
}

async function runHarnessLoop(
  state: HarnessState,
  config: ModelConfig,
  onEvent: EventCallback
): Promise<HarnessState> {
  while (state.iteration < state.maxIterations) {
    state.iteration++;
    onEvent({
      type: "iteration_start",
      iteration: state.iteration,
      maxIterations: state.maxIterations,
    });

    const nextItem = getNextPendingItem(state);
    if (nextItem) {
      onEvent({
        type: "executor_start",
        itemId: nextItem.id,
        itemDescription: nextItem.description,
      });
    }

    const result = await execute(state, config.executor, {
      onToken: (token) => onEvent({ type: "executor_token", token }),
      onToolUse: (use) =>
        onEvent({
          type: "executor_tool",
          name: use.name,
          detail: toolDetail(use.input),
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
