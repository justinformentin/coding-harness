import { plan } from "./planner.js";
import { execute } from "./executor.js";
import { verify } from "./verifier.js";
import { repairPrompt } from "./prompts.js";
import { createInitialState, getNextPendingItem } from "./state.js";
import {
  saveRunInit,
  saveChecklist,
  saveStateCheckpoint,
  appendIteration,
  appendVerifierReport,
} from "./run-store.js";
import type { HarnessState, ModelConfig, VerifierReport } from "./schemas.js";

export type HarnessEvent =
  | { type: "plan_start" }
  | { type: "plan_complete"; itemCount: number }
  | { type: "iteration_start"; iteration: number; maxIterations: number }
  | { type: "executor_start"; itemId: string; itemDescription: string }
  | { type: "executor_complete"; response: string; toolCalls: number }
  | { type: "tool_result"; name: string; success: boolean; output: string }
  | { type: "verify_start" }
  | { type: "verify_complete"; report: VerifierReport }
  | { type: "repair"; instruction: string }
  | { type: "complete"; state: HarnessState }
  | { type: "max_iterations"; state: HarnessState }
  | { type: "error"; message: string };

export type EventCallback = (event: HarnessEvent) => void;

export async function runHarness(
  prompt: string,
  config: ModelConfig,
  onEvent: EventCallback,
  maxIterations: number = 10
): Promise<HarnessState> {
  const state = createInitialState(prompt, maxIterations);

  try {
    // Save initial run data
    await saveRunInit(state, config);

    // Plan
    onEvent({ type: "plan_start" });
    state.checklist = await plan(prompt, config.planner);
    await saveChecklist(state);
    onEvent({ type: "plan_complete", itemCount: state.checklist.length });

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

      // Execute
      const result = await execute(state, config.executor);
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
      onEvent({ type: "verify_complete", report });

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
      onEvent({ type: "repair", instruction: report.nextInstruction });
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

    const result = await execute(state, config.executor);
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
    onEvent({ type: "verify_complete", report });

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
    onEvent({ type: "repair", instruction: report.nextInstruction });
  }

  onEvent({ type: "max_iterations", state });
  return state;
}
