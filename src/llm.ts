import { randomUUID } from "crypto";
import type {
  Message,
  RoleModelConfig,
  ChatOptions,
  ToolDefinition,
  ModelResult,
  ModelToolCall,
  ModelUsage,
} from "./schemas.js";
import { runClaudeCode } from "./claude-code.js";
import { normalizeStopReason } from "./completion.js";
import {
  classifyModelError,
  ModelError,
  modelErrorForResponse,
  retryModelCall,
} from "./model-retry.js";

type LLMMessage = { role: "user" | "assistant" | "system"; content: string };
type RawResult = {
  text: string;
  toolCalls: ModelToolCall[];
  usage: ModelUsage;
  rawStopReason?: string;
};

function convertMessages(messages: Message[]): LLMMessage[] {
  return messages.map((message) => ({
    role: message.role === "tool" ? "user" : message.role,
    content:
      message.role === "tool"
        ? `[Tool Result]\n${message.content}`
        : message.content,
  }));
}

async function* parseSSE(
  response: Response,
): AsyncGenerator<{ event?: string; data: string }> {
  if (!response.body)
    throw new ModelError("Response body is null", "transient");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        let event: string | undefined;
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          if (line.startsWith("data:"))
            yield { event, data: line.slice(5).trimStart() };
        }
      }
    }
    if (buffer.trim()) {
      let event: string | undefined;
      for (const line of buffer.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:"))
          yield { event, data: line.slice(5).trimStart() };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function toolDefinitions(
  tools: ToolDefinition[] | undefined,
  anthropic = false,
) {
  return tools?.map((tool) =>
    anthropic
      ? {
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        }
      : {
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        },
  );
}

function parseArguments(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return { _malformed: value };
  }
}

/** Compatibility adapter for models without native tool calling. */
export function parseToolCallsFromText(text: string): ModelToolCall[] {
  const calls: ModelToolCall[] = [];
  for (const match of text.matchAll(/```tool\s*\n?([\s\S]*?)\n?```/g)) {
    try {
      const parsed = JSON.parse(match[1].trim()) as Record<string, unknown>;
      if (typeof parsed.name === "string")
        calls.push({
          id: `compat_${calls.length}`,
          name: parsed.name,
          arguments: extractToolArguments(parsed),
        });
    } catch {
      // Invalid compatibility blocks are ignored; structured-output callers
      // persist parse failures at their contract boundary.
    }
  }
  return calls;
}

export function extractToolArguments(
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  if (parsed.arguments && typeof parsed.arguments === "object")
    return parsed.arguments as Record<string, unknown>;
  const { name: _name, arguments: _arguments, ...rest } = parsed;
  return rest;
}

async function completeOpenAI(
  config: RoleModelConfig,
  systemPrompt: string,
  messages: Message[],
  options: ChatOptions,
): Promise<RawResult> {
  const local = config.provider === "local";
  if (local && !config.baseUrl)
    throw new ModelError("Local provider requires a baseUrl", "policy");
  const baseUrl = config.baseUrl || "https://api.openai.com/v1";
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const body: Record<string, unknown> = {
    model: config.model,
    messages: [
      { role: "system", content: systemPrompt },
      ...convertMessages(messages),
    ],
    temperature: options.temperature ?? config.temperature ?? 0.2,
    stream: true,
  };
  if (!local) body.stream_options = { include_usage: true };
  const maxTokens =
    options.maxTokens ?? config.localOptions?.maxTokens ?? config.maxTokens;
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  if (
    options.responseFormat &&
    (!local || config.localOptions?.supportsJsonMode)
  )
    body.response_format = { type: options.responseFormat };
  if (
    options.tools?.length &&
    (!local || config.localOptions?.supportsToolCalling)
  ) {
    body.tools = toolDefinitions(options.tools);
    if (!local) body.tool_choice = "auto";
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    throw classifyModelError(error);
  }
  if (!response.ok)
    throw modelErrorForResponse(
      config.provider,
      config.model,
      response.status,
      await response.text(),
    );

  let text = "";
  let rawStopReason: string | undefined;
  let usage: ModelUsage = {};
  const native = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  for await (const item of parseSSE(response)) {
    if (item.data === "[DONE]") break;
    if (!item.data) continue;
    let parsed: {
      choices?: Array<{
        delta?: {
          content?: string | null;
          tool_calls?: Array<{
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string | null;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };
    try {
      parsed = JSON.parse(item.data);
    } catch {
      continue;
    }
    if (parsed.usage)
      usage = {
        inputTokens: parsed.usage.prompt_tokens,
        outputTokens: parsed.usage.completion_tokens,
        totalTokens: parsed.usage.total_tokens,
      };
    const choice = parsed.choices?.[0];
    if (choice?.finish_reason) rawStopReason = choice.finish_reason;
    if (choice?.delta?.content) {
      text += choice.delta.content;
      options.onToken?.(choice.delta.content);
    }
    for (const delta of choice?.delta?.tool_calls ?? []) {
      const current = native.get(delta.index) ?? {
        id: delta.id ?? `call_${delta.index}`,
        name: "",
        arguments: "",
      };
      if (delta.id) current.id = delta.id;
      if (delta.function?.name) current.name += delta.function.name;
      if (delta.function?.arguments)
        current.arguments += delta.function.arguments;
      native.set(delta.index, current);
    }
  }
  const toolCalls = [...native.values()]
    .filter((call) => call.name)
    .map((call) => ({
      id: call.id,
      name: call.name,
      arguments: parseArguments(call.arguments),
    }));
  return {
    text,
    toolCalls: toolCalls.length ? toolCalls : parseToolCallsFromText(text),
    usage,
    rawStopReason,
  };
}

async function completeAnthropic(
  config: RoleModelConfig,
  systemPrompt: string,
  messages: Message[],
  options: ChatOptions,
): Promise<RawResult> {
  const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey)
    throw new ModelError("ANTHROPIC_API_KEY is required", "authentication");
  const thinking = options.thinking ?? config.thinking;
  const budget = thinking?.budgetTokens ?? 10_000;
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens:
      options.maxTokens ??
      config.maxTokens ??
      (thinking?.enabled ? budget + 8192 : 16000),
    system: systemPrompt,
    messages: convertMessages(messages).filter(
      (message) => message.role !== "system",
    ),
    stream: true,
    temperature: thinking?.enabled
      ? 1
      : (options.temperature ?? config.temperature ?? 0.2),
  };
  if (thinking?.enabled)
    body.thinking = { type: "enabled", budget_tokens: budget };
  if (options.tools?.length) body.tools = toolDefinitions(options.tools, true);
  let response: Response;
  try {
    response = await fetch(
      `${config.baseUrl || "https://api.anthropic.com"}/v1/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: options.signal,
      },
    );
  } catch (error) {
    throw classifyModelError(error);
  }
  if (!response.ok)
    throw modelErrorForResponse(
      "anthropic",
      config.model,
      response.status,
      await response.text(),
    );

  let text = "";
  let rawStopReason: string | undefined;
  let usage: ModelUsage = {};
  const native = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  for await (const item of parseSSE(response)) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(item.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (item.event === "message_start") {
      const message = parsed.message as
        { usage?: { input_tokens?: number } } | undefined;
      usage.inputTokens = message?.usage?.input_tokens;
    } else if (item.event === "content_block_start") {
      const index = Number(parsed.index ?? 0);
      const block = parsed.content_block as
        { type?: string; id?: string; name?: string } | undefined;
      if (block?.type === "tool_use")
        native.set(index, {
          id: block.id ?? `call_${index}`,
          name: block.name ?? "",
          arguments: "",
        });
    } else if (item.event === "content_block_delta") {
      const index = Number(parsed.index ?? 0);
      const delta = parsed.delta as
        { type?: string; text?: string; partial_json?: string } | undefined;
      if (delta?.type === "text_delta" && delta.text) {
        text += delta.text;
        options.onToken?.(delta.text);
      }
      if (delta?.type === "input_json_delta" && delta.partial_json) {
        const call = native.get(index);
        if (call) call.arguments += delta.partial_json;
      }
    } else if (item.event === "message_delta") {
      const delta = parsed.delta as { stop_reason?: string } | undefined;
      const eventUsage = parsed.usage as { output_tokens?: number } | undefined;
      rawStopReason = delta?.stop_reason ?? rawStopReason;
      usage.outputTokens = eventUsage?.output_tokens;
    }
  }
  if (usage.inputTokens !== undefined || usage.outputTokens !== undefined)
    usage.totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  const toolCalls = [...native.values()]
    .filter((call) => call.name)
    .map((call) => ({
      id: call.id,
      name: call.name,
      arguments: parseArguments(call.arguments),
    }));
  return {
    text,
    toolCalls: toolCalls.length ? toolCalls : parseToolCallsFromText(text),
    usage,
    rawStopReason,
  };
}

function flattenForClaudeCode(messages: Message[]): string {
  return messages
    .map((message) =>
      message.role === "user"
        ? message.content
        : `[${message.role}]\n${message.content}`,
    )
    .join("\n\n");
}

async function completeClaudeCode(
  config: RoleModelConfig,
  systemPrompt: string,
  messages: Message[],
  options: ChatOptions,
  parentSpanId: string,
): Promise<RawResult> {
  const result = await runClaudeCode({
    prompt: flattenForClaudeCode(messages),
    systemPrompt: systemPrompt || undefined,
    model: config.model,
    allowedTools: config.claudeCode?.allowedTools,
    disallowedTools: config.claudeCode?.disallowedTools ?? [
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
    ],
    dangerouslySkipPermissions:
      config.claudeCode?.dangerouslySkipPermissions ?? true,
    isolateConfig: config.claudeCode?.isolateConfig,
    settingSources: config.claudeCode?.settingSources,
    signal: options.signal,
    onToken: options.onToken,
    onToolUse: (use) => {
      options.onToolUse?.(use);
      const spanId = randomUUID();
      options.onToolTrace?.({
        phase: "start",
        spanId,
        parentSpanId,
        name: use.name,
      });
      options.onToolTrace?.({
        phase: "end",
        spanId,
        parentSpanId,
        name: use.name,
        success: true,
      });
    },
  });
  return {
    text: result.text,
    toolCalls: parseToolCallsFromText(result.text),
    usage: {},
    rawStopReason: "end_turn",
  };
}

async function completeOnce(
  config: RoleModelConfig,
  systemPrompt: string,
  messages: Message[],
  options: ChatOptions,
  spanId: string,
): Promise<RawResult> {
  if (config.provider === "anthropic")
    return completeAnthropic(config, systemPrompt, messages, options);
  if (config.provider === "claude-code")
    return completeClaudeCode(config, systemPrompt, messages, options, spanId);
  return completeOpenAI(config, systemPrompt, messages, options);
}

export async function chat(
  config: RoleModelConfig,
  systemPrompt: string,
  messages: Message[],
  options: ChatOptions = {},
): Promise<ModelResult> {
  return retryModelCall(
    async (attempt) => {
      const spanId = randomUUID();
      const startedAt = Date.now();
      options.onTrace?.({
        phase: "start",
        spanId,
        provider: config.provider,
        model: config.model,
        attempt,
      });
      try {
        const raw = await completeOnce(
          config,
          systemPrompt,
          messages,
          options,
          spanId,
        );
        const result: ModelResult = {
          text: raw.text,
          toolCalls: raw.toolCalls,
          usage: raw.usage,
          stopReason: normalizeStopReason(config.provider, raw.rawStopReason),
          provider: config.provider,
          model: config.model,
          spanId,
        };
        options.onFinish?.(raw.rawStopReason);
        options.onTrace?.({
          phase: "end",
          spanId,
          provider: config.provider,
          model: config.model,
          attempt,
          durationMs: Date.now() - startedAt,
          result,
        });
        return result;
      } catch (error) {
        const classified = classifyModelError(error);
        options.onTrace?.({
          phase: "end",
          spanId,
          provider: config.provider,
          model: config.model,
          attempt,
          durationMs: Date.now() - startedAt,
          error: { kind: classified.kind, message: classified.message },
        });
        throw classified;
      }
    },
    config.retry,
    { signal: options.signal },
  );
}

export async function* chatStreamWithSystem(
  config: RoleModelConfig,
  systemPrompt: string,
  messages: Message[],
  options: ChatOptions = {},
): AsyncGenerator<string> {
  const result = await chat(config, systemPrompt, messages, options);
  yield result.text;
}

export async function* chatStream(
  config: RoleModelConfig,
  messages: Message[],
  options: ChatOptions = {},
): AsyncGenerator<string> {
  const first = messages[0] as { role?: string; content: string } | undefined;
  const systemPrompt = first?.role === "system" ? first.content : "";
  yield* chatStreamWithSystem(
    config,
    systemPrompt,
    first?.role === "system" ? messages.slice(1) : messages,
    options,
  );
}

export async function checkLocalModel(
  config: RoleModelConfig,
): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  if (!config.baseUrl)
    return { ok: false, error: "Local provider requires a baseUrl" };
  try {
    const response = await fetch(`${config.baseUrl}/models`);
    if (!response.ok)
      return { ok: false, error: `Server responded with ${response.status}` };
    const data = (await response.json()) as { data?: Array<{ id?: string }> };
    return {
      ok: true,
      models: (data.data ?? []).map((model) => model.id ?? "").filter(Boolean),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
