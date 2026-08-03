import { plan } from "./planner.js";
import { executeToCompletion } from "./executor.js";
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
  FileRunStore,
} from "./run-store.js";
import type {
  HarnessState,
  ResolvedConfig,
  PlannerChecklistItem,
  VerifierReport,
} from "./schemas.js";
import { debug, time } from "./debug.js";
import { DependencyScheduler, blockedSteps } from "./scheduler.js";
import { DeterministicRunController } from "./run-controller.js";
import {
  captureWorkspaceDiff,
  verifyStepAssertions,
} from "./assertion-verifier.js";
import type { StopReason } from "./contracts/result.js";
import type { ModelTrace } from "./contracts/model.js";
import { judgeWithModel } from "./model-judge.js";

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
      type: "model_call_start" | "model_call_end";
      spanId: string;
      provider: string;
      model: string;
      callAttempt: number;
      durationMs?: number;
      usage?: Record<string, number | undefined>;
      stopReason?: string;
      error?: { kind: string; message: string };
    }
  | {
      type: "tool_call_start" | "tool_call_end";
      spanId: string;
      parentSpanId: string;
      name: string;
      success?: boolean;
    }
  | {
      type: "parse_failure";
      role: "planner" | "verifier";
      parseAttempt: number;
      error: string;
      artifact: string;
    }
  | {
      type: "context_compacted";
      stepId: string;
      removedMessages: number;
      artifact: string;
    }
  | {
      type: "step_transition";
      stepId: string;
      from: PlannerChecklistItem["status"];
      to: PlannerChecklistItem["status"];
    }
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
  | {
      type: "attempt_complete";
      stepId: string;
      attempt: number;
      iteration: number;
      modelCalls: number;
      toolCalls: number;
      stepAttempts: Record<string, number>;
    }
  | { type: "repair"; instruction: string; runId: string }
  | { type: "complete"; state: HarnessState }
  | { type: "max_iterations"; state: HarnessState }
  | { type: "budget_exhausted"; reason: StopReason; state: HarnessState }
  | { type: "blocked"; reason: StopReason; state: HarnessState }
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
  const durableWrites = new Set<Promise<void>>();
  const runStore = new FileRunStore(state.runId);

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
    if (!SKIP_LOG_EVENTS.has(event.type)) {
      const write = appendEvent(state.runId, event);
      durableWrites.add(write);
      void write.then(
        () => durableWrites.delete(write),
        () => durableWrites.delete(write),
      );
    }
    onEvent(event);
    schedule();
  };

  const flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    await Promise.all([...durableWrites]);
    await save();
    await runStore.writeCheckpoint(await runStore.replay());
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

function boundedRunSignal(
  state: HarnessState,
  config: ResolvedConfig,
  external?: AbortSignal,
): AbortSignal {
  const controller = new AbortController();
  const remaining = Math.max(
    0,
    state.startedAt + config.loop.deadlineSeconds * 1000 - Date.now(),
  );
  const timer = setTimeout(() => controller.abort("deadline"), remaining);
  timer.unref?.();
  if (external?.aborted) controller.abort(external.reason);
  else
    external?.addEventListener(
      "abort",
      () => controller.abort(external.reason),
      { once: true },
    );
  return controller.signal;
}

// Append any queued steering messages to the conversation as user turns and
// surface each one to the UI. Called at the start of every iteration so
// follow-ups the user typed mid-run take effect on the next execute step.
function applySteering(
  state: HarnessState,
  emit: EventCallback,
  drainSteering?: () => string[],
  stepId?: string,
): void {
  const pending = drainSteering?.() ?? [];
  for (const message of pending) {
    state.messages.push({ role: "user", content: message });
    if (stepId)
      (state.stepMessages[stepId] ??= []).push({
        role: "user",
        content: message,
      });
    emit({ type: "steering", message });
  }
}

const STEP_TRANSITIONS: Record<
  PlannerChecklistItem["status"],
  PlannerChecklistItem["status"][]
> = {
  pending: ["ready", "blocked", "failed", "skipped"],
  ready: ["executing", "retryable", "failed"],
  executing: ["verifying", "retryable", "failed"],
  verifying: ["passed", "retryable", "failed"],
  passed: ["retryable"],
  retryable: ["ready", "blocked", "failed", "skipped"],
  blocked: [],
  failed: [],
  skipped: [],
};

function transitionStep(
  item: PlannerChecklistItem,
  to: PlannerChecklistItem["status"],
  emit: EventCallback,
): void {
  const from = item.status;
  if (!STEP_TRANSITIONS[from].includes(to))
    throw new Error(`Invalid step transition for ${item.id}: ${from} -> ${to}`);
  item.status = to;
  emit({ type: "step_transition", stepId: item.id, from, to });
}

function modelTraceHandler(
  state: HarnessState,
  emit: EventCallback,
): (trace: ModelTrace) => void {
  return (trace) => {
    if (trace.phase === "start") {
      state.modelCalls++;
      emit({
        type: "model_call_start",
        spanId: trace.spanId,
        provider: trace.provider,
        model: trace.model,
        callAttempt: trace.attempt,
      });
    } else {
      emit({
        type: "model_call_end",
        spanId: trace.spanId,
        provider: trace.provider,
        model: trace.model,
        callAttempt: trace.attempt,
        durationMs: trace.durationMs,
        usage: trace.result?.usage,
        stopReason: trace.result?.stopReason,
        error: trace.error,
      });
    }
  };
}

function toolTraceHandler(emit: EventCallback) {
  return (trace: {
    phase: "start" | "end";
    spanId: string;
    parentSpanId: string;
    name: string;
    success?: boolean;
  }) =>
    emit({
      type: trace.phase === "start" ? "tool_call_start" : "tool_call_end",
      spanId: trace.spanId,
      parentSpanId: trace.parentSpanId,
      name: trace.name,
      success: trace.success,
    });
}

async function persistParseFailure(
  state: HarnessState,
  emit: EventCallback,
  failure: {
    role: "planner" | "verifier";
    attempt: number;
    error: string;
    text: string;
  },
): Promise<void> {
  const artifact = await new FileRunStore(state.runId).putArtifact(
    failure.text,
  );
  emit({
    type: "parse_failure",
    role: failure.role,
    parseAttempt: failure.attempt,
    error: failure.error,
    artifact,
  });
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
  const runSignal = boundedRunSignal(state, config, options.signal);
  const { emit, flush } = createEmitter(state, onEvent);
  const onModelTrace = modelTraceHandler(state, emit);
  const onToolTrace = toolTraceHandler(emit);
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
        onToolUse: (use) => {
          state.toolCalls++;
          emit({
            type: "plan_tool",
            name: use.name,
            detail: toolDetail(use.input),
          });
        },
        onModelTrace,
        onToolTrace,
        onParseFailure: (failure) => persistParseFailure(state, emit, failure),
        signal: runSignal,
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
        state.stopReason = "cancelled";
        emit({ type: "plan_rejected" });
        await flush();
        return state;
      }
      emit({ type: "plan_approved" });
    }

    // Add initial user message for executor conversation
    state.messages.push({ role: "user", content: prompt });

    await runHarnessLoop(state, config, emit, {
      ...options,
      signal: runSignal,
    });
    await flush();
    return state;
  } catch (e: unknown) {
    // A user-requested stop surfaces as an abort here (e.g. the planner was
    // mid-call). Report it as a clean stop, not an error.
    if (isAbortError(runSignal, e)) {
      state.stopReason = options.signal?.aborted ? "cancelled" : "deadline";
      debug("harness", "runHarness aborted — stopping cleanly");
      if (state.stopReason === "cancelled") emit({ type: "stopped", state });
      else emit({ type: "budget_exhausted", reason: "deadline", state });
      await flush().catch(() => {});
      return state;
    }
    const msg = e instanceof Error ? e.message : String(e);
    state.stopReason = "fatal_error";
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
  // Durable attempts and counters are intentionally retained across resume.
  if (options?.maxIterations !== undefined)
    state.maxIterations = options.maxIterations;
  const runSignal = boundedRunSignal(state, config, options?.signal);
  const { emit, flush } = createEmitter(state, onEvent);
  try {
    await runHarnessLoop(state, config, emit, {
      ...options,
      signal: runSignal,
    });
    await flush();
    return state;
  } catch (e: unknown) {
    if (isAbortError(runSignal, e)) {
      state.stopReason = options?.signal?.aborted ? "cancelled" : "deadline";
      debug("harness", "resumeHarness aborted — stopping cleanly");
      if (state.stopReason === "cancelled") emit({ type: "stopped", state });
      else emit({ type: "budget_exhausted", reason: "deadline", state });
      await flush().catch(() => {});
      return state;
    }
    const msg = e instanceof Error ? e.message : String(e);
    state.stopReason = "fatal_error";
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
  const scheduler = new DependencyScheduler();
  const controller = new DeterministicRunController(state, config);
  const onModelTrace = modelTraceHandler(state, emit);
  const onToolTrace = toolTraceHandler(emit);

  // A persisted in-flight operation was interrupted before verification could
  // establish an outcome. Resume it as retryable without losing its counters.
  for (const interrupted of state.checklist.filter((item) =>
    ["ready", "executing", "verifying"].includes(item.status),
  )) {
    transitionStep(interrupted, "retryable", emit);
  }

  const stop = (reason: StopReason): HarnessState => {
    state.stopReason = reason;
    if (reason === "cancelled") emit({ type: "stopped", state });
    else if (reason === "blocked") emit({ type: "blocked", reason, state });
    else emit({ type: "budget_exhausted", reason, state });
    return state;
  };

  while (true) {
    if (
      state.maxIterations !== undefined &&
      state.iteration >= state.maxIterations
    ) {
      state.stopReason = "max_attempts";
      emit({ type: "max_iterations", state });
      return state;
    }

    const item = scheduler.next(state.checklist);
    if (!item) {
      if (state.checklist.every((step) => step.status === "passed")) {
        state.stopReason = "completed";
        emit({ type: "complete", state });
        return state;
      }
      debug("harness", "scheduler found no runnable step", {
        blocked: blockedSteps(state.checklist),
      });
      for (const blocked of state.checklist.filter((step) =>
        ["pending", "retryable"].includes(step.status),
      ))
        transitionStep(blocked, "blocked", emit);
      return stop("blocked");
    }

    const preflight = controller.beforeAttempt(item.id, signal);
    if (preflight) {
      if (preflight === "max_attempts") transitionStep(item, "failed", emit);
      return stop(preflight);
    }

    const attempt = (state.stepAttempts[item.id] ?? 0) + 1;
    transitionStep(item, "ready", emit);
    transitionStep(item, "executing", emit);
    debug("harness", `attempt ${attempt} for ${item.id} start`);
    emit({
      type: "iteration_start",
      iteration: state.iteration + 1,
      maxIterations: state.maxIterations,
    });

    // Inject any mid-run steering the user queued while we were busy
    applySteering(state, emit, options?.drainSteering, item.id);

    const result = await time(
      "harness",
      `step ${item.id} attempt ${attempt} execute`,
      () =>
        executeToCompletion(state, config.executor, {
          targetItemId: item.id,
          maxModelCalls: config.loop.maxModelCalls - state.modelCalls,
          maxToolCalls: config.loop.maxToolCalls - state.toolCalls,
          contextLimits: config.context,
          onModelTrace,
          onToolTrace,
          onContextCompacted: async ({ stepId, messages }) => {
            const artifact = await new FileRunStore(state.runId).putArtifact(
              JSON.stringify(messages),
            );
            emit({
              type: "context_compacted",
              stepId,
              removedMessages: messages.length,
              artifact,
            });
            return artifact;
          },
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
    debug("harness", `step ${item.id} execute returned`, {
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

    emit({ type: "verify_start" });
    transitionStep(item, "verifying", emit);
    const assertionTimeoutMs = Math.max(
      1,
      Math.min(
        config.workspace.commandTimeoutSeconds * 1000,
        state.startedAt + config.loop.deadlineSeconds * 1000 - Date.now(),
      ),
    );
    const verification = await verifyStepAssertions(
      item,
      state,
      config.workspace.root,
      assertionTimeoutMs,
      config.workspace.maxOutputBytes,
      ({ rubric, evidence }) =>
        state.modelCalls >= config.loop.maxModelCalls
          ? Promise.reject(new Error("model call budget exhausted"))
          : judgeWithModel(
              config.verifier,
              { rubric, evidence },
              {
                signal,
                onModelTrace,
                onParseFailure: (failure) =>
                  persistParseFailure(state, emit, failure),
              },
            ),
    );
    const completedItems: string[] = [];
    const incompleteItems: string[] = [];
    const missingEvidence = [...verification.failures];
    const assertionResults = verification.assertions.map((result) => ({
      stepId: item.id,
      assertion: result.assertion,
      kind: result.kind,
      status: result.status,
      expected: result.expected,
      actual: result.actual,
      confidence: result.confidence,
      evidenceIds: result.evidenceIds,
    }));
    if (verification.status === "failed") {
      transitionStep(item, "retryable", emit);
      incompleteItems.push(item.id);
    } else {
      transitionStep(item, "passed", emit);
      completedItems.push(item.id);
      if (
        verification.status === "human_review" &&
        !state.reviewRequired.includes(item.id)
      )
        state.reviewRequired.push(item.id);
    }

    // Later edits can invalidate earlier steps, so re-run their assertions.
    for (const previous of state.checklist) {
      if (previous.id === item.id || previous.status !== "passed") continue;
      const regression = await verifyStepAssertions(
        previous,
        state,
        config.workspace.root,
        assertionTimeoutMs,
        config.workspace.maxOutputBytes,
        ({ rubric, evidence }) =>
          state.modelCalls >= config.loop.maxModelCalls
            ? Promise.reject(new Error("model call budget exhausted"))
            : judgeWithModel(
                config.verifier,
                { rubric, evidence },
                {
                  signal,
                  onModelTrace,
                  onParseFailure: (failure) =>
                    persistParseFailure(state, emit, failure),
                },
              ),
      );
      assertionResults.push(
        ...regression.assertions.map((result) => ({
          stepId: previous.id,
          assertion: result.assertion,
          kind: result.kind,
          status: result.status,
          expected: result.expected,
          actual: result.actual,
          confidence: result.confidence,
          evidenceIds: result.evidenceIds,
        })),
      );
      if (regression.status === "failed") {
        transitionStep(previous, "retryable", emit);
        incompleteItems.push(previous.id);
        missingEvidence.push(...regression.failures);
      } else completedItems.push(previous.id);
    }
    const done = state.checklist.every((step) => step.status === "passed");
    const report: VerifierReport = {
      done,
      completedItems: [...new Set(completedItems)],
      incompleteItems: [...new Set(incompleteItems)],
      missingEvidence,
      nextInstruction: missingEvidence.length
        ? `Address the following: ${missingEvidence.join("; ")}`
        : "",
      assertionResults,
    };
    state.verifierReport = report;
    await appendVerifierReport(state, report);
    emit({ type: "verify_complete", report, runId: state.runId });

    const budgetStop = controller.recordAttempt({
      stepId: item.id,
      modelCalls: 0,
      toolCalls: result.toolCalls.filter((call) => call.name !== "finish")
        .length,
      failures: missingEvidence,
      workspaceDiff: await captureWorkspaceDiff(config.workspace.root),
    });
    emit({
      type: "attempt_complete",
      stepId: item.id,
      attempt,
      iteration: state.iteration,
      modelCalls: state.modelCalls,
      toolCalls: state.toolCalls,
      stepAttempts: { ...state.stepAttempts },
    });
    await appendIteration(state, {
      stepId: item.id,
      attempt,
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
      state.stopReason = "completed";
      emit({ type: "complete", state });
      return state;
    }

    if (budgetStop) return stop(budgetStop);

    // Repair prompt
    debug("harness", `step ${item.id} attempt ${attempt} needs repair`);
    const repair = repairPrompt(report);
    state.messages.push({ role: "user", content: repair });
    emit({
      type: "repair",
      instruction: report.nextInstruction,
      runId: state.runId,
    });
  }
}
