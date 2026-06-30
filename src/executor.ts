import { chat, chatStreamWithSystem, extractToolArguments } from "./llm.js";
import { executorSystemPrompt, claudeCodeExecutorPrompt } from "./prompts.js";
import { executeTool } from "./tools.js";
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
};

export async function execute(
  state: HarnessState,
  config: RoleModelConfig,
  callbacks?: ExecutorCallbacks
): Promise<ExecutorResult> {
  const onToken = callbacks?.onToken;
  // Claude Code provider: spawn a fresh sub-Claude scoped to a single item.
  if (config.provider === "claude-code") {
    return executeItemWithClaudeCode(state, config, callbacks);
  }

  // Mark next pending item as in_progress
  const nextItem = state.checklist.find((i) => i.status === "pending");
  if (nextItem) nextItem.status = "in_progress";

  const systemPrompt = executorSystemPrompt(state);

  // Build messages from state (already includes any prior conversation)
  const messages: Message[] = [...state.messages];

  let response: string;

  if (onToken) {
    // Streaming path: collect chunks and forward each token via the callback
    const chunks: string[] = [];
    for await (const chunk of chatStreamWithSystem(config, systemPrompt, messages)) {
      chunks.push(chunk);
      onToken(chunk);
    }
    response = chunks.join("");
  } else {
    // Non-streaming path (fallback when no onToken provided)
    const chatResponse = await chat(config, systemPrompt, messages);
    response = chatResponse.content;
  }

  // Parse tool calls from response text (freeform ```tool blocks)
  const toolCalls = parseToolCalls(response);
  const toolResults: ExecutorResult["toolResults"] = [];

  // Execute tool calls
  for (const tc of toolCalls) {
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

  return { response, toolCalls, toolResults };
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

async function executeItemWithClaudeCode(
  state: HarnessState,
  config: RoleModelConfig,
  callbacks?: ExecutorCallbacks
): Promise<ExecutorResult> {
  const onToken = callbacks?.onToken;
  // Pick the item to work on: resume an in-progress one (a repair attempt),
  // otherwise start the next pending item. This is the "which sub-Claude does
  // which task" link the verifier relies on.
  const item: PlannerChecklistItem | undefined =
    state.checklist.find((i) => i.status === "in_progress") ??
    state.checklist.find((i) => i.status === "pending");

  if (!item) {
    return { response: "", toolCalls: [], toolResults: [] };
  }
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
