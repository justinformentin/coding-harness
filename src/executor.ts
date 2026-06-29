import { chat } from "./llm.js";
import { executorSystemPrompt } from "./prompts.js";
import { executeTool } from "./tools.js";
import type { HarnessState, Message, RoleModelConfig } from "./schemas.js";
import { appendCommand } from "./run-store.js";

type ToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export type ExecutorResult = {
  response: string;
  toolCalls: ToolCall[];
  toolResults: { name: string; output: string; success: boolean }[];
};

export async function execute(
  state: HarnessState,
  config: RoleModelConfig
): Promise<ExecutorResult> {
  // Mark next pending item as in_progress
  const nextItem = state.checklist.find((i) => i.status === "pending");
  if (nextItem) nextItem.status = "in_progress";

  const systemPrompt = executorSystemPrompt(state);

  // Build messages from state (already includes any prior conversation)
  const messages: Message[] = [...state.messages];

  const response = await chat(config, systemPrompt, messages);

  // Parse tool calls from response
  const toolCalls = parseToolCalls(response);
  const toolResults: ExecutorResult["toolResults"] = [];

  // Execute tool calls
  for (const tc of toolCalls) {
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

function parseToolCalls(response: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const toolBlockRegex = /```tool\s*\n?([\s\S]*?)\n?```/g;
  let match;

  while ((match = toolBlockRegex.exec(response)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim()) as {
        name?: unknown;
        arguments?: Record<string, unknown>;
      };
      if (parsed.name && typeof parsed.name === "string") {
        calls.push({
          name: parsed.name,
          arguments: parsed.arguments || {},
        });
      }
    } catch {
      // Skip malformed tool calls
    }
  }

  return calls;
}
