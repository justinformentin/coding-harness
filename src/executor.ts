import { chat, extractToolArguments } from "./llm.js";
import { executorSystemPrompt, claudeCodeExecutorPrompt } from "./prompts.js";
import { executeTool, modelToolDefinitions } from "./tools.js";
import {
  FINISH_TOOL_NAME,
  parseFinishCall,
  decideExecutorDone,
} from "./completion.js";
import { runClaudeCode, gitChangedFiles } from "./claude-code.js";
import { debug } from "./debug.js";
import type {
  HarnessState,
  Message,
  PlannerChecklistItem,
  RoleModelConfig,
} from "./schemas.js";
import { appendCommand } from "./run-store.js";
import {
  buildStepContext,
  type ContextLimits,
  truncateUtf8,
} from "./context.js";
import { randomUUID } from "crypto";
import type { ModelTrace } from "./contracts/model.js";
import type { ModelStopReason, ModelResult } from "./contracts/model.js";

type ParsedToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export type ExecutorResult = {
  response: string;
  toolCalls: ParsedToolCall[];
  toolResults: { name: string; output: string; success: boolean }[];
  modelCalls: number;
};

export type ExecutorCallbacks = {
  onToken?: (token: string) => void;
  /** Fires in real time each time the executor invokes a tool. */
  onToolUse?: (use: { name: string; input: unknown }) => void;
  /**
   * Fires when the executor begins work on a checklist item (one call per item
   * for claude-code, once for the current target on text providers). Lets the
   * harness surface per-item progress now that a single execute call may span
   * several items / turns.
   */
  onItemStart?: (item: { id: string; description: string }) => void;
  /**
   * Aborts in-flight model calls / sub-Claude subprocesses when the run is
   * stopped. runClaudeCode kills its child on abort; the text providers cancel
   * their fetch. Threaded through every provider path below.
   */
  signal?: AbortSignal;
  /** Restrict this pass to the scheduler-selected item. */
  targetItemId?: string;
  maxModelCalls?: number;
  maxToolCalls?: number;
  contextLimits?: ContextLimits;
  onModelTrace?: (trace: ModelTrace) => void;
  onToolTrace?: (trace: {
    phase: "start" | "end";
    spanId: string;
    parentSpanId: string;
    name: string;
    success?: boolean;
  }) => void;
  onContextCompacted?: (input: {
    stepId: string;
    messages: Message[];
  }) => Promise<string | undefined>;
};

// Safety cap on how many model turns one execute-to-completion pass may take on
// the text providers (openai / anthropic / local) before we hand control back
// to the verifier. Guards against a model that keeps calling tools forever.
// Not used by claude-code, whose sub-Claude bounds itself internally.
const MAX_EXECUTOR_STEPS = 50;

/**
 * Drive the executor to completion for a single iteration, then return.
 *
 * "Completion" is provider-specific:
 *   - claude-code: each sub-Claude already runs its own task to completion, so
 *     completion here means draining every outstanding checklist item — one
 *     sub-Claude per item.
 *   - openai / anthropic / local: a single chat call is just one turn, so we
 *     loop the call-model → run-tools cycle until the model stops requesting
 *     tools (or we hit MAX_EXECUTOR_STEPS).
 *
 * The harness calls this once per iteration and only verifies afterwards, so
 * verification sees a finished attempt rather than firing after every step.
 */
export async function executeToCompletion(
  state: HarnessState,
  config: RoleModelConfig,
  callbacks?: ExecutorCallbacks,
): Promise<ExecutorResult> {
  debug("executor", "executeToCompletion", {
    provider: config.provider,
    pending: state.checklist.filter((i) => i.status === "pending").length,
    inProgress: state.checklist.filter((i) => i.status === "executing").length,
  });
  // Provider-specific: claude-code spawns one fresh sub-Claude per item.
  if (config.provider === "claude-code") {
    return executeAllItemsWithClaudeCode(state, config, callbacks);
  }
  // Provider-specific: openai / anthropic / local share the freeform-tool loop.
  return executeTextToCompletion(state, config, callbacks);
}

// ─────────────────────────────────────────────────────────────────────────────
// Text providers (openai / anthropic / local): agentic turn loop
// ─────────────────────────────────────────────────────────────────────────────

async function executeTextToCompletion(
  state: HarnessState,
  config: RoleModelConfig,
  callbacks?: ExecutorCallbacks,
): Promise<ExecutorResult> {
  // Text providers don't map individual turns to checklist items, so we just
  // mark the next pending item in_progress and announce the current target.
  const nextItem = callbacks?.targetItemId
    ? state.checklist.find((i) => i.id === callbacks.targetItemId)
    : state.checklist.find((i) => i.status === "pending");
  if (nextItem) nextItem.status = "executing";
  const current = callbacks?.targetItemId
    ? state.checklist.find((i) => i.id === callbacks.targetItemId)
    : state.checklist.find((i) => i.status === "executing");
  if (current) {
    callbacks?.onItemStart?.({
      id: current.id,
      description: current.description,
    });
  }

  const aggregate: ExecutorResult = {
    response: "",
    toolCalls: [],
    toolResults: [],
    modelCalls: 0,
  };

  const maxTurns = Math.min(
    MAX_EXECUTOR_STEPS,
    callbacks?.maxModelCalls ?? MAX_EXECUTOR_STEPS,
  );
  for (let step = 0; step < maxTurns; step++) {
    debug("executor", `text turn ${step} start`);
    const turn = await executeTextTurn(state, config, callbacks);
    aggregate.modelCalls++;
    debug("executor", `text turn ${step} done`, {
      toolCalls: turn.toolCalls.length,
      stopReason: turn.stopReason,
    });
    aggregate.response += (aggregate.response ? "\n" : "") + turn.response;
    aggregate.toolCalls.push(...turn.toolCalls);
    aggregate.toolResults.push(...turn.toolResults);

    if (
      aggregate.toolCalls.filter((call) => call.name !== FINISH_TOOL_NAME)
        .length >= (callbacks?.maxToolCalls ?? Number.POSITIVE_INFINITY)
    )
      break;

    // Record any explicit completion claim so the verifier can credit manual
    // items the model says it finished.
    const finish = parseFinishCall(turn.toolCalls);
    if (finish) {
      for (const id of finish.completedItems) {
        if (!state.executorClaims.includes(id)) state.executorClaims.push(id);
      }
    }

    // Stop only on a deterministic signal: an explicit finish, or a clean stop
    // with no tools pending. `finish` doesn't count as pending work, so it's
    // excluded from the tool-call count.
    const decision = decideExecutorDone({
      toolCallCount: turn.toolCalls.filter((t) => t.name !== FINISH_TOOL_NAME)
        .length,
      finishCalled: Boolean(finish),
      stopReason: turn.stopReason,
    });
    if (decision.done) break;
  }

  return aggregate;
}

// Run a single text-provider turn: one model call, then run any tool calls it
// emitted, appending both to the conversation. Returns this turn's results
// (plus the raw stop reason) so the caller can decide whether to loop again.
async function executeTextTurn(
  state: HarnessState,
  config: RoleModelConfig,
  callbacks?: ExecutorCallbacks,
): Promise<ExecutorResult & { stopReason: ModelStopReason }> {
  const onToken = callbacks?.onToken;
  const systemPrompt = executorSystemPrompt(state);
  const current = callbacks?.targetItemId
    ? state.checklist.find((item) => item.id === callbacks.targetItemId)
    : state.checklist.find((item) => item.status === "executing");
  if (!current) throw new Error("Executor has no current step");
  const limits = callbacks?.contextLimits ?? {
    maxMessages: 40,
    maxBytes: 200_000,
  };
  let view = buildStepContext(state, current, limits);
  if (view.compacted.length) {
    const artifact = await callbacks?.onContextCompacted?.({
      stepId: current.id,
      messages: view.compacted,
    });
    state.stepMessages[current.id] = view.retainedHistory;
    if (artifact) {
      const artifacts = (state.contextArtifacts[current.id] ??= []);
      if (!artifacts.includes(artifact)) artifacts.push(artifact);
    }
    view = buildStepContext(state, current, limits);
  }

  const modelResult = await chat(config, systemPrompt, view.messages, {
    tools: modelToolDefinitions(),
    onToken,
    onTrace: callbacks?.onModelTrace,
    onToolTrace: callbacks?.onToolTrace,
    signal: callbacks?.signal,
  });
  const response = modelResult.text;
  const toolCalls = modelResult.toolCalls.map((call) => ({
    name: call.name,
    arguments: call.arguments,
  }));
  const toolResults: ExecutorResult["toolResults"] = [];

  // Execute tool calls
  for (const tc of toolCalls) {
    callbacks?.onToolUse?.({ name: tc.name, input: tc.arguments });
    const spanId = randomUUID();
    callbacks?.onToolTrace?.({
      phase: "start",
      spanId,
      parentSpanId: modelResult.spanId,
      name: tc.name,
    });
    // `finish` is a sentinel with no side effect, but it is still traced as a
    // complete tool operation so every observed call has a matching span.
    if (tc.name === FINISH_TOOL_NAME) {
      callbacks?.onToolTrace?.({
        phase: "end",
        spanId,
        parentSpanId: modelResult.spanId,
        name: tc.name,
        success: true,
      });
      continue;
    }
    const result = await executeTool(tc.name, tc.arguments);
    callbacks?.onToolTrace?.({
      phase: "end",
      spanId,
      parentSpanId: modelResult.spanId,
      name: tc.name,
      success: result.success,
    });
    toolResults.push({
      name: tc.name,
      output: result.output,
      success: result.success,
    });

    // Track artifacts
    if (tc.name === "run_command") {
      const cmd = tc.arguments.command as string;
      state.artifacts.commandsRun.push(cmd);
      state.artifacts.commandOutputs.push(result.output);
      await appendCommand(state, cmd, result.output);
    }
    if (["write_file", "edit_file"].includes(tc.name)) {
      const path = tc.arguments.path as string;
      if (!state.artifacts.filesChanged.includes(path)) {
        state.artifacts.filesChanged.push(path);
      }
    }
  }

  // Build tool results message for conversation
  const toolOutputStr =
    toolResults.length > 0
      ? toolResults
          .map((r) => `[${r.name}] ${r.success ? "OK" : "ERROR"}: ${r.output}`)
          .join("\n\n")
      : "";

  // Update messages
  const stepHistory = (state.stepMessages[current.id] ??= []);
  stepHistory.push({ role: "assistant", content: response });
  if (toolOutputStr) {
    stepHistory.push({ role: "tool", content: toolOutputStr });
  }
  state.messages.push({
    role: "assistant",
    content: `[${current.id}] ${truncateUtf8(response, 1000)}`,
  });

  return {
    response,
    toolCalls,
    toolResults,
    modelCalls: 1,
    stopReason: modelResult.stopReason,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude Code executor: one sub-Claude per checklist item
// ─────────────────────────────────────────────────────────────────────────────

type ClaudeSummary = {
  summary?: string;
  filesChanged: string[];
  commandsRun: { command: string; output: string }[];
  evidenceFound: string[];
};

// Run every outstanding checklist item to completion this pass, one sub-Claude
// per item, then return. We snapshot the items up front rather than looping on
// live status: a sub-Claude leaves its item in_progress (the VERIFIER is what
// marks items done), so a `while (pending || in_progress)` loop would spin
// forever on the first item. The snapshot covers both fresh runs (pending) and
// repair passes (items the verifier left in_progress).
async function executeAllItemsWithClaudeCode(
  state: HarnessState,
  config: RoleModelConfig,
  callbacks?: ExecutorCallbacks,
): Promise<ExecutorResult> {
  const items = callbacks?.targetItemId
    ? state.checklist.filter((item) => item.id === callbacks.targetItemId)
    : state.checklist.filter(
        (i) => i.status === "pending" || i.status === "retryable",
      );

  const aggregate: ExecutorResult = {
    response: "",
    toolCalls: [],
    toolResults: [],
    modelCalls: 0,
  };

  debug("executor", "claude-code: executing items", {
    itemCount: items.length,
    itemIds: items.map((i) => i.id),
  });
  for (const item of items) {
    debug("executor", `claude-code: item ${item.id} start`, {
      description: item.description,
    });
    callbacks?.onItemStart?.({ id: item.id, description: item.description });
    const turn = await executeItemWithClaudeCode(
      state,
      config,
      item,
      callbacks,
    );
    aggregate.modelCalls += turn.modelCalls;
    debug("executor", `claude-code: item ${item.id} done`, {
      toolCalls: turn.toolCalls.length,
    });
    aggregate.response += (aggregate.response ? "\n\n" : "") + turn.response;
    aggregate.toolCalls.push(...turn.toolCalls);
    aggregate.toolResults.push(...turn.toolResults);
  }

  return aggregate;
}

async function executeItemWithClaudeCode(
  state: HarnessState,
  config: RoleModelConfig,
  item: PlannerChecklistItem,
  callbacks?: ExecutorCallbacks,
): Promise<ExecutorResult> {
  const onToken = callbacks?.onToken;
  // The caller selected this item; mark it in_progress so the verifier can link
  // this sub-Claude's work to the right task.
  item.status = "executing";

  const prompt = claudeCodeExecutorPrompt(state, item);
  const boundedPrompt = truncateUtf8(
    prompt,
    callbacks?.contextLimits?.maxBytes ?? 200_000,
  );
  const before = new Set(gitChangedFiles());
  const toolCalls: ParsedToolCall[] = [];
  const modelSpanId = randomUUID();
  const modelStartedAt = Date.now();
  callbacks?.onModelTrace?.({
    phase: "start",
    spanId: modelSpanId,
    provider: config.provider,
    model: config.model,
    attempt: 1,
  });

  // If a prior sub-Claude already worked this item (a repair pass, or a resumed
  // run after the harness was interrupted mid-item), continue its own session
  // instead of cold-starting — the sub-Claude keeps the context of what it had
  // already done.
  const sessions = (state.claudeSessions ??= {});
  const resumeSessionId = sessions[item.id];

  let result;
  try {
    result = await runClaudeCode({
      prompt: boundedPrompt,
      model: config.model,
      allowedTools: config.claudeCode?.allowedTools,
      disallowedTools: config.claudeCode?.disallowedTools,
      // The executor must edit files and run commands unattended.
      dangerouslySkipPermissions:
        config.claudeCode?.dangerouslySkipPermissions ?? true,
      isolateConfig: config.claudeCode?.isolateConfig,
      settingSources: config.claudeCode?.settingSources,
      resumeSessionId,
      signal: callbacks?.signal,
      onToken,
      onToolUse: (use) => {
        toolCalls.push({
          name: use.name,
          arguments: (use.input as Record<string, unknown>) ?? {},
        });
        callbacks?.onToolUse?.({ name: use.name, input: use.input });
        const toolSpanId = randomUUID();
        callbacks?.onToolTrace?.({
          phase: "start",
          spanId: toolSpanId,
          parentSpanId: modelSpanId,
          name: use.name,
        });
        callbacks?.onToolTrace?.({
          phase: "end",
          spanId: toolSpanId,
          parentSpanId: modelSpanId,
          name: use.name,
          success: true,
        });
      },
    });
  } catch (error) {
    callbacks?.onModelTrace?.({
      phase: "end",
      spanId: modelSpanId,
      provider: config.provider,
      model: config.model,
      attempt: 1,
      durationMs: Date.now() - modelStartedAt,
      error: {
        kind: "unknown",
        message: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
  const normalized: ModelResult = {
    text: result.text,
    toolCalls: [],
    usage: {},
    stopReason: "stop",
    provider: config.provider,
    model: config.model,
    spanId: modelSpanId,
  };
  callbacks?.onModelTrace?.({
    phase: "end",
    spanId: modelSpanId,
    provider: config.provider,
    model: config.model,
    attempt: 1,
    durationMs: Date.now() - modelStartedAt,
    result: normalized,
  });

  // Remember this item's session so a later repair/resume pass can continue it.
  if (result.sessionId) sessions[item.id] = result.sessionId;

  const summary = parseClaudeSummary(result.text);

  // Attribute on-disk changes to this item: union of what the sub-Claude
  // reported and what git actually shows as newly changed.
  const after = gitChangedFiles();
  const gitDelta = after.filter((f) => !before.has(f));
  const filesChanged = [
    ...new Set([...(summary?.filesChanged ?? []), ...gitDelta]),
  ];
  for (const f of filesChanged) {
    if (!state.artifacts.filesChanged.includes(f)) {
      state.artifacts.filesChanged.push(f);
    }
  }

  // Record the commands the sub-Claude ran so the verifier's deterministic
  // checks (requiredCommands / successIndicators) can see them as evidence.
  const toolResults: ExecutorResult["toolResults"] = [];
  for (const c of summary?.commandsRun ?? []) {
    state.artifacts.commandsRun.push(c.command);
    state.artifacts.commandOutputs.push(c.output);
    await appendCommand(state, c.command, c.output);
    toolResults.push({
      name: "run_command",
      output: `$ ${c.command}\n${c.output}`,
      success: true,
    });
  }

  if (summary?.evidenceFound && summary.evidenceFound.length > 0) {
    item.evidenceFound = [
      ...new Set([...item.evidenceFound, ...summary.evidenceFound]),
    ];
  }

  // The sub-Claude ran this item to completion and self-reported — record the
  // "work was done" claim the verifier uses for manual items. We require a
  // parsed summary so a crashed/garbled run doesn't count as a claim.
  if (summary && !state.executorClaims.includes(item.id)) {
    state.executorClaims.push(item.id);
  }

  // Keep the conversation record small: store the summary, not the full run.
  const summaryText = summary?.summary ?? result.text;
  state.messages.push({
    role: "assistant",
    content: `[${item.id}] ${summaryText}`,
  });

  return { response: result.text, toolCalls, toolResults, modelCalls: 1 };
}

function parseClaudeSummary(text: string): ClaudeSummary | null {
  // Prefer the last fenced ```json block; fall back to the last raw object.
  const fences = [...text.matchAll(/```json\s*\n?([\s\S]*?)\n?```/g)];
  let raw: string | null = fences.length ? fences[fences.length - 1][1] : null;
  if (!raw) {
    const objMatch = text.match(/\{[\s\S]*\}/);
    raw = objMatch ? objMatch[0] : null;
  }
  if (!raw) return null;

  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    return {
      summary: typeof p.summary === "string" ? p.summary : undefined,
      filesChanged: Array.isArray(p.filesChanged)
        ? p.filesChanged.filter((x): x is string => typeof x === "string")
        : [],
      commandsRun: Array.isArray(p.commandsRun)
        ? p.commandsRun
            .filter(
              (c): c is { command: string; output?: unknown } =>
                Boolean(c) &&
                typeof (c as { command?: unknown }).command === "string",
            )
            .map((c) => ({
              command: c.command,
              output: typeof c.output === "string" ? c.output : "",
            }))
        : [],
      evidenceFound: Array.isArray(p.evidenceFound)
        ? p.evidenceFound.filter((x): x is string => typeof x === "string")
        : [],
    };
  } catch {
    return null;
  }
}

export function parseToolCalls(response: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  const toolBlockRegex = /```tool\s*\n?([\s\S]*?)\n?```/g;
  let match;

  while ((match = toolBlockRegex.exec(response)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim()) as Record<string, unknown>;
      const name = parsed.name;
      if (name && typeof name === "string") {
        calls.push({
          name,
          arguments: extractToolArguments(parsed),
        });
      }
    } catch {
      // Skip malformed tool calls
    }
  }

  return calls;
}
