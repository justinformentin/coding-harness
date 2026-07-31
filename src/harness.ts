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
  appendEvent,
} from "./run-store.js";
import type {
  HarnessState,
  ResolvedConfig,
  PlannerChecklistItem,
  VerifierReport,
} from "./schemas.js";
import { debug, time } from "./debug.js";

export type HarnessEvent =
  | { type: "run_init"; runId: string }
  | { type: "plan_start" }
  | { type: "plan_token"; token: string }
  | { type: "plan_tool"; name: string; detail?: string }
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
  | { type: "stopped"; state: HarnessState }
  | { type: "error"; message: string };

export type EventCallback = (event: HarnessEvent) => void;

// How long to coalesce state writes. Every emitted event schedules a checkpoint;
// the debounce collapses token/tool storms into at most one write per window so
// the on-disk state.json tracks progress within ~this many ms of real time
// without hammering the disk on every streamed token.
const CHECKPOINT_DEBOUNCE_MS = 750;

// High-frequency streaming events that are pure live-UI preview (the finalized
// text/tool calls arrive via other events). Kept out of the durable transcript
// so events.jsonl stays lean and the append chain doesn't fall behind a stream.
const SKIP_LOG_EVENTS = new Set<HarnessEvent["type"]>([
  "plan_token",
  "executor_token",
]);

type Emitter = {
  // Persist (unless high-frequency), forward to the UI, and schedule a
  // debounced state checkpoint. Use this everywhere instead of the raw
  // onEvent callback.
  emit: EventCallback;
  // Force an immediate checkpoint (cancels any pending debounce). Call before
  // returning from the loop so the final state is always on disk.
  flush: () => Promise<void>;
};

// Wire an event callback to durable persistence: an ordered transcript
// (events.jsonl) and a debounced state.json checkpoint. Because `state` is
// mutated in place by the planner/executor/verifier, a checkpoint triggered by
// any event serializes the current live state — so progress is saved
// continuously through a long iteration, not only at its end.
function createEmitter(state: HarnessState, onEvent: EventCallback): Emitter {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;

  const save = () => {
    pending = false;
    return saveStateCheckpoint(state).catch(() => {
      // Best-effort: a failed checkpoint must never break the run.
    });
  };

  const schedule = () => {
    pending = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (pending) void save();
    }, CHECKPOINT_DEBOUNCE_MS);
    timer.unref?.();
  };

  const emit: EventCallback = (event) => {
    if (!SKIP_LOG_EVENTS.has(event.type)) void appendEvent(state.runId, event);
    onEvent(event);
    schedule();
  };

  const flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    await save();
  };

  return { emit, flush };
}

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
    checklist: PlannerChecklistItem[],
  ) => Promise<"approve" | "reject">;
  // Pulled at the top of each iteration to inject mid-run "steering" messages
  // the user typed while the loop was running. Returns the queued messages and
  // is expected to clear the queue. They are appended to the executor
  // conversation as user turns before the next execute step.
  drainSteering?: () => string[];
  /**
   * Cancels the run when aborted: stops the loop at the next boundary and tears
   * down any in-flight model call / sub-Claude subprocess (threaded down to
   * runClaudeCode, which kills its child). The harness treats an abort as a
   * clean stop — it emits a `stopped` event rather than an `error`.
   */
  signal?: AbortSignal;
};

// True when the given error is the result of the run's AbortSignal firing,
// rather than a genuine failure. Abort surfaces differently by provider (a
// thrown "aborted" Error from runClaudeCode, a DOMException from a cancelled
// fetch), so we check the signal state as the source of truth and treat the
// error text as a secondary hint.
function isAbortError(signal: AbortSignal | undefined, e: unknown): boolean {
  if (signal?.aborted) return true;
  if (e instanceof Error) {
    return e.name === "AbortError" || /abort/i.test(e.message);
  }
  return false;
}

// Append any queued steering messages to the conversation as user turns and
// surface each one to the UI. Called at the start of every iteration so
// follow-ups the user typed mid-run take effect on the next execute step.
function applySteering(
  state: HarnessState,
  emit: EventCallback,
  drainSteering?: () => string[],
): void {
  const pending = drainSteering?.() ?? [];
  for (const message of pending) {
    state.messages.push({ role: "user", content: message });
    emit({ type: "steering", message });
  }
}

export async function runHarness(
  prompt: string,
  config: ResolvedConfig,
  onEvent: EventCallback,
  options: HarnessOptions = {},
): Promise<HarnessState> {
  // The cap is honored only when the caller explicitly sets one. Otherwise it
  // stays undefined and the loop runs until the verifier is satisfied.
  const maxIterations = options.maxIterations;

  const state = createInitialState(prompt, maxIterations);
  const { emit, flush } = createEmitter(state, onEvent);
  debug("harness", "runHarness starting", {
    runId: state.runId,
    maxIterations,
    plannerProvider: config.planner.provider,
    executorProvider: config.executor.provider,
    verifierProvider: config.verifier.provider,
  });

  try {
    // Save initial run data (creates the run dir) before emitting any event, so
    // the durable transcript has somewhere to land.
    await time("harness", "saveRunInit", () => saveRunInit(state, config));
    emit({ type: "run_init", runId: state.runId });

    // Plan
    emit({ type: "plan_start" });
    state.checklist = await time("harness", "plan()", () =>
      plan(prompt, config.planner, {
        onToken: (token) => emit({ type: "plan_token", token }),
        onToolUse: (use) =>
          emit({
            type: "plan_tool",
            name: use.name,
            detail: toolDetail(use.input),
          }),
        signal: options.signal,
      }),
    );
    debug("harness", "plan complete", { itemCount: state.checklist.length });
    await time("harness", "saveChecklist", () => saveChecklist(state));

    emit({ type: "plan_complete", itemCount: state.checklist.length });

    // Save plan as readable markdown and show it for review
    const planPath = await time("harness", "savePlanMarkdown", () =>
      savePlanMarkdown(state),
    );
    emit({ type: "plan_review", planPath, checklist: state.checklist });

    // If an approval callback is provided, wait for approval
    if (options.onPlanReview) {
      debug("harness", "awaiting plan review decision (blocks on user)…");
      const decision = await options.onPlanReview(planPath, state.checklist);
      debug("harness", "plan review decision received", { decision });
      if (decision === "reject") {
        emit({ type: "plan_rejected" });
        await flush();
        return state;
      }
      emit({ type: "plan_approved" });
    }

    // Add initial user message for executor conversation
    state.messages.push({ role: "user", content: prompt });

    await runHarnessLoop(state, config, emit, options);
    await flush();
    return state;
  } catch (e: unknown) {
    // A user-requested stop surfaces as an abort here (e.g. the planner was
    // mid-call). Report it as a clean stop, not an error.
    if (isAbortError(options.signal, e)) {
      debug("harness", "runHarness aborted — stopping cleanly");
      emit({ type: "stopped", state });
      await flush().catch(() => {});
      return state;
    }
    const msg = e instanceof Error ? e.message : String(e);
    debug("harness", "runHarness threw", { error: msg });
    emit({ type: "error", message: msg });
    await flush().catch(() => {});
    throw e;
  }
}

export async function resumeHarness(
  state: HarnessState,
  config: ResolvedConfig,
  onEvent: EventCallback,
  options?: Pick<HarnessOptions, "drainSteering" | "maxIterations" | "signal">,
): Promise<HarnessState> {
  // Reset iteration counter to allow more attempts.
  state.iteration = 0;
  // Re-derive the cap from current explicit sources rather than trusting the
  // (possibly stale) value saved with the run. With no explicit cap this is
  // undefined, so the resumed run is unbounded too.
  state.maxIterations = options?.maxIterations;
  const { emit, flush } = createEmitter(state, onEvent);
  try {
    await runHarnessLoop(state, config, emit, options);
    await flush();
    return state;
  } catch (e: unknown) {
    if (isAbortError(options?.signal, e)) {
      debug("harness", "resumeHarness aborted — stopping cleanly");
      emit({ type: "stopped", state });
      await flush().catch(() => {});
      return state;
    }
    const msg = e instanceof Error ? e.message : String(e);
    debug("harness", "resumeHarness threw", { error: msg });
    emit({ type: "error", message: msg });
    await flush().catch(() => {});
    throw e;
  }
}

// The execute → verify → repair loop shared by fresh and resumed runs. All
// events go through `emit`, which persists the transcript and debounce-writes
// state.json continuously (see createEmitter).
async function runHarnessLoop(
  state: HarnessState,
  config: ResolvedConfig,
  emit: EventCallback,
  options?: Pick<HarnessOptions, "drainSteering" | "maxIterations" | "signal">,
): Promise<HarnessState> {
  const signal = options?.signal;
  // Main loop. Runs until the verifier reports done, or — when a cap is set —
  // until that many iterations have run.
  while (
    state.maxIterations === undefined ||
    state.iteration < state.maxIterations
  ) {
    // A stop requested between iterations ends the run cleanly before we kick
    // off any more work. Mid-iteration stops surface as an abort from the
    // execute/verify calls and are caught by the callers of this loop.
    if (signal?.aborted) {
      debug("harness", "loop saw abort at iteration boundary — stopping");
      emit({ type: "stopped", state });
      return state;
    }
    state.iteration++;
    debug("harness", `iteration ${state.iteration} start`, {
      maxIterations: state.maxIterations,
    });
    emit({
      type: "iteration_start",
      iteration: state.iteration,
      maxIterations: state.maxIterations,
    });

    // Inject any mid-run steering the user queued while we were busy
    applySteering(state, emit, options?.drainSteering);

    // Execute to completion — the executor runs every outstanding item / turn
    // before returning, so the verifier below sees a finished attempt rather
    // than firing after each small step. Per-item progress is surfaced via
    // onItemStart. Tokens and tool uses stream to the TUI in real time.
    const result = await time(
      "harness",
      `iteration ${state.iteration} execute`,
      () =>
        executeToCompletion(state, config.executor, {
          onToken: (token) => emit({ type: "executor_token", token }),
          onToolUse: (use) =>
            emit({
              type: "executor_tool",
              name: use.name,
              detail: toolDetail(use.input),
            }),
          onItemStart: (item) =>
            emit({
              type: "executor_start",
              itemId: item.id,
              itemDescription: item.description,
            }),
          signal,
        }),
    );
    debug("harness", `iteration ${state.iteration} execute returned`, {
      toolCalls: result.toolCalls.length,
      responseLen: result.response.length,
    });
    emit({
      type: "executor_complete",
      response: result.response,
      toolCalls: result.toolCalls.length,
    });

    // Report tool results
    for (const tr of result.toolResults) {
      emit({
        type: "tool_result",
        name: tr.name,
        success: tr.success,
        output: tr.output,
      });
    }

    // Verify
    emit({ type: "verify_start" });
    const report = await time(
      "harness",
      `iteration ${state.iteration} verify`,
      () => verify(state, config.verifier, signal),
    );
    debug("harness", `iteration ${state.iteration} verify returned`, {
      done: report.done,
      completed: report.completedItems.length,
      incomplete: report.incompleteItems.length,
    });
    state.verifierReport = report;
    await appendVerifierReport(state, report);
    emit({ type: "verify_complete", report, runId: state.runId });

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
      debug("harness", "verifier reports done — run complete", {
        runId: state.runId,
        iterations: state.iteration,
      });
      emit({ type: "complete", state });
      return state;
    }

    // Repair prompt
    debug("harness", `iteration ${state.iteration} not done — queuing repair`);
    const repair = repairPrompt(report);
    state.messages.push({ role: "user", content: repair });
    emit({
      type: "repair",
      instruction: report.nextInstruction,
      runId: state.runId,
    });
  }

  // Max iterations reached
  debug("harness", "max iterations reached", { iteration: state.iteration });
  emit({ type: "max_iterations", state });
  return state;
}
