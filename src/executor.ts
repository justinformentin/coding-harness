import { chat, chatStreamWithSystem, extractToolArguments } from "./llm.js";
import { executorSystemPrompt, claudeCodeExecutorPrompt } from "./prompts.js";
import { executeTool } from "./tools.js";
import {
  FINISH_TOOL_NAME,
  parseFinishCall,
  normalizeStopReason,
  decideExecutorDone,
} from "./completion.js";
import { runClaudeCode, gitChangedFiles } from "./claude-code.js";
import type {
  HarnessState,
  Message,
  PlannerChecklistItem,
  RoleModelConfig,
} from "./schemas.js";
import { appendCommand } from "./run-store.js";

type ParsedToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export type ExecutorResult = {
  response: string;
  toolCalls: ParsedToolCall[];
  toolResults: { name: string; output: string; success: boolean }[];
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
  callbacks?: ExecutorCallbacks
): Promise<ExecutorResult> {
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
  callbacks?: ExecutorCallbacks
): Promise<ExecutorResult> {
  // Text providers don't map individual turns to checklist items, so we just
  // mark the next pending item in_progress and announce the current target.
  const nextItem = state.checklist.find((i) => i.status === "pending");
  if (nextItem) nextItem.status = "in_progress";
  const current = state.checklist.find((i) => i.status === "in_progress");
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
  };

  for (let step = 0; step < MAX_EXECUTOR_STEPS; step++) {
    const turn = await executeTextTurn(state, config, callbacks);
    aggregate.response += (aggregate.response ? "\n" : "") + turn.response;
    aggregate.toolCalls.push(...turn.toolCalls);
    aggregate.toolResults.push(...turn.toolResults);

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
      stopReason: normalizeStopReason(config.provider, turn.stopReason),
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
  callbacks?: ExecutorCallbacks
): Promise<ExecutorResult & { stopReason: string | undefined }> {
  const onToken = callbacks?.onToken;
  const systemPrompt = executorSystemPrompt(state);

  // Build messages from state (already includes any prior conversation +
  // tool results from earlier turns this pass).
  const messages: Message[] = [...state.messages];

  // Capture the provider's raw stop reason so the loop can tell a natural stop
  // from a truncation (hit token cap → not actually done).
  let stopReason: string | undefined;
  const chatOptions = { onFinish: (raw?: string) => { stopReason = raw; } };

  let response: string;

  if (onToken) {
    // Streaming path: collect chunks and forward each token via the callback
    const chunks: string[] = [];
    for await (const chunk of chatStreamWithSystem(
      config,
      systemPrompt,
      messages,
      chatOptions
    )) {
      chunks.push(chunk);
      onToken(chunk);
    }
    response = chunks.join("");
  } else {
    // Non-streaming path (fallback when no onToken provided)
    const chatResponse = await chat(config, systemPrompt, messages, chatOptions);
    response = chatResponse.content;
  }

  // Parse tool calls from response text (freeform ```tool blocks)
  const toolCalls = parseToolCalls(response);
  const toolResults: ExecutorResult["toolResults"] = [];

  // Execute tool calls
  for (const tc of toolCalls) {
    // `finish` is a sentinel with no side effect — the loop reads it to decide
    // when to stop, but there's nothing to execute.
    if (tc.name === FINISH_TOOL_NAME) continue;
    callbacks?.onToolUse?.({ name: tc.name, input: tc.arguments });
    const result = await executeTool(tc.name, tc.arguments);
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
          .map(
            (r) =>
              `[${r.name}] ${r.success ? "OK" : "ERROR"}: ${r.output}`
          )
          .join("\n\n")
      : "";

  // Update messages
  state.messages.push({ role: "assistant", content: response });
  if (toolOutputStr) {
    state.messages.push({ role: "tool", content: toolOutputStr });
  }

  return { response, toolCalls, toolResults, stopReason };
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
  callbacks?: ExecutorCallbacks
): Promise<ExecutorResult> {
  const items = state.checklist.filter(
    (i) => i.status === "pending" || i.status === "in_progress"
  );

  const aggregate: ExecutorResult = {
    response: "",
    toolCalls: [],
    toolResults: [],
  };

  for (const item of items) {
    callbacks?.onItemStart?.({ id: item.id, description: item.description });
    const turn = await executeItemWithClaudeCode(state, config, item, callbacks);
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
  callbacks?: ExecutorCallbacks
): Promise<ExecutorResult> {
  const onToken = callbacks?.onToken;
  // The caller selected this item; mark it in_progress so the verifier can link
  // this sub-Claude's work to the right task.
  item.status = "in_progress";

  const prompt = claudeCodeExecutorPrompt(state, item);
  const before = new Set(gitChangedFiles());
  const toolCalls: ParsedToolCall[] = [];

  const result = await runClaudeCode({
    prompt,
    model: config.model,
    allowedTools: config.claudeCode?.allowedTools,
    disallowedTools: config.claudeCode?.disallowedTools,
    // The executor must edit files and run commands unattended.
    dangerouslySkipPermissions:
      config.claudeCode?.dangerouslySkipPermissions ?? true,
    onToken,
    onToolUse: (use) => {
      toolCalls.push({
        name: use.name,
        arguments: (use.input as Record<string, unknown>) ?? {},
      });
      callbacks?.onToolUse?.({ name: use.name, input: use.input });
    },
  });

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

  return { response: result.text, toolCalls, toolResults };
}

function parseClaudeSummary(text: string): ClaudeSummary | null {
  // Prefer the last fenced ```json block; fall back to the last raw object.
  const fences = [...text.matchAll(/```json\s*\n?([\s\S]*?)\n?```/g)];
  let raw: string | null = fences.length
    ? fences[fences.length - 1][1]
    : null;
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
                typeof (c as { command?: unknown }).command === "string"
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

function parseToolCalls(response: string): ParsedToolCall[] {
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
