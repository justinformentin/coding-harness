import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type {
  Message,
  RoleModelConfig,
  ModelConfig,
  ChatOptions,
  ChatResponse,
  ToolCall,
  ToolDefinition,
} from "./schemas.js";
import { ModelConfigSchema } from "./schemas.js";
import { runClaudeCode } from "./claude-code.js";

// ─────────────────────────────────────────────────────────────────────────────
// Internal message types
// ─────────────────────────────────────────────────────────────────────────────

type LLMMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

function convertMessages(messages: Message[]): LLMMessage[] {
  return messages.map((m) => ({
    role:
      m.role === "tool" ? ("user" as const) : (m.role as "user" | "assistant"),
    content:
      m.role === "tool" ? `[Tool Result]\n${m.content}` : m.content,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE parsing utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a Server-Sent Events stream from a Response body.
 * Yields each `data:` line's content (already stripped of the "data: " prefix).
 */
async function* parseSSE(
  response: Response
): AsyncGenerator<string> {
  if (!response.body) throw new Error("Response body is null");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Split by double-newline (SSE event separator)
      const events = buffer.split(/\n\n/);
      // Keep incomplete trailing event in buffer
      buffer = events.pop() ?? "";

      for (const event of events) {
        // Each event may have multiple lines; find data: lines
        for (const line of event.split("\n")) {
          if (line.startsWith("data: ")) {
            yield line.slice(6);
          }
        }
      }
    }

    // Flush any remaining buffer
    if (buffer.trim()) {
      for (const line of buffer.split("\n")) {
        if (line.startsWith("data: ")) {
          yield line.slice(6);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI-compatible streaming
//
// This path handles:
//   - provider: "openai"  → https://api.openai.com/v1
//   - provider: "local"   → OpenAI-compatible endpoint (Ollama, LM Studio,
//                           vLLM, llama.cpp, etc.) at a user-supplied baseUrl.
//                           No auth required; just point baseUrl at the server.
// ─────────────────────────────────────────────────────────────────────────────

async function* chatStreamOpenAI(
  config: RoleModelConfig,
  systemPrompt: string,
  messages: Message[],
  options: ChatOptions = {}
): AsyncGenerator<string> {
  const isLocal = config.provider === "local";

  // Local provider requires an explicit baseUrl — no defaults.
  if (isLocal && !config.baseUrl) {
    throw new Error(
      "Local provider requires a baseUrl (e.g. http://localhost:11434/v1 for Ollama, http://localhost:1234/v1 for LM Studio)"
    );
  }

  const baseUrl = config.baseUrl || "https://api.openai.com/v1";
  const apiKey =
    config.apiKey ||
    (config.provider === "openai" ? process.env.OPENAI_API_KEY : undefined);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const llmMessages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    ...convertMessages(messages),
  ];

  const body: Record<string, unknown> = {
    model: config.model,
    messages: llmMessages,
    temperature: options.temperature ?? config.temperature ?? 0.2,
    stream: true,
  };

  if (isLocal) {
    // Local models: only send max_tokens if explicitly configured
    const localMaxTokens =
      options.maxTokens ?? config.localOptions?.maxTokens ?? config.maxTokens;
    if (localMaxTokens !== undefined) {
      body.max_tokens = localMaxTokens;
    }

    // response_format only if json mode is explicitly supported
    if (options.responseFormat && config.localOptions?.supportsJsonMode) {
      body.response_format = { type: options.responseFormat };
    }

    // Tool calling only if explicitly supported
    if (
      options.tools &&
      options.tools.length > 0 &&
      config.localOptions?.supportsToolCalling
    ) {
      body.tools = options.tools.map((t: ToolDefinition) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      // Do NOT send tool_choice — most local servers don't support it
    }
  } else {
    // OpenAI: only send max_tokens if explicitly configured; OpenAI has
    // sensible defaults and we shouldn't impose an arbitrary cap.
    const maxTokens = options.maxTokens ?? config.maxTokens;
    if (maxTokens !== undefined) {
      body.max_tokens = maxTokens;
    }

    if (options.responseFormat) {
      body.response_format = { type: options.responseFormat };
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t: ToolDefinition) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      body.tool_choice = "auto";
    }
  }

  const controller = new AbortController();
  const signal = options.signal
    ? combineSignals(options.signal, controller.signal)
    : controller.signal;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isLocal && (msg.includes("ECONNREFUSED") || msg.includes("fetch failed"))) {
      throw new Error(
        `Could not connect to local model server at ${baseUrl}. Is the server running? (${msg})`
      );
    }
    throw err;
  }

  if (!response.ok) {
    const text = await response.text();
    if (isLocal) {
      // Try to surface helpful hints for common local model errors
      const lower = text.toLowerCase();
      if (lower.includes("max_tokens") || lower.includes("maximum")) {
        throw new Error(
          `Local model error [${config.model}] (${response.status}): ${text}\nHint: Try removing or lowering maxTokens / localOptions.maxTokens in your config.`
        );
      }
      if (lower.includes("tool") || lower.includes("function")) {
        throw new Error(
          `Local model error [${config.model}] (${response.status}): ${text}\nHint: This model may not support tool calling. Set localOptions.supportsToolCalling: false in your config.`
        );
      }
      if (lower.includes("response_format") || lower.includes("json")) {
        throw new Error(
          `Local model error [${config.model}] (${response.status}): ${text}\nHint: This model may not support JSON mode. Set localOptions.supportsJsonMode: false in your config.`
        );
      }
    }
    throw new Error(
      `OpenAI-compatible request failed [${config.provider}/${config.model}] (${response.status}): ${text}`
    );
  }

  // OpenAI SSE format:
  //   data: {"choices":[{"delta":{"content":"token"}}]}
  //   data: [DONE]
  // The last non-empty chunk carries finish_reason ("stop" | "length" |
  // "tool_calls" | ...); we remember it and report it via onFinish at the end.
  let finishReason: string | undefined;
  for await (const line of parseSSE(response)) {
    if (line === "[DONE]") break;
    if (!line.trim()) continue;

    try {
      const parsed = JSON.parse(line) as {
        choices?: Array<{
          delta?: {
            content?: string | null;
            tool_calls?: Array<{
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string;
        }>;
      };

      const choice = parsed.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta;
      if (delta?.content) {
        yield delta.content;
      }
      // Note: tool_call deltas are NOT yielded as text — they are accumulated
      // in chat() which wraps this generator and parses tool calls from the
      // full response text (or via native tool_calls in the final message).
    } catch {
      // Ignore malformed SSE lines
    }
  }
  options.onFinish?.(finishReason);
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic streaming
//
// Anthropic uses SSE with named events. The relevant events are:
//   event: content_block_delta
//   data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
//
//   event: message_stop   ← signals end of stream
// ─────────────────────────────────────────────────────────────────────────────

async function* chatStreamAnthropic(
  config: RoleModelConfig,
  systemPrompt: string,
  messages: Message[],
  options: ChatOptions = {}
): AsyncGenerator<string> {
  const baseUrl = config.baseUrl || "https://api.anthropic.com";
  const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      `ANTHROPIC_API_KEY is required for Anthropic provider [model: ${config.model}]`
    );
  }

  const anthropicMessages = convertMessages(messages).filter(
    (m) => m.role !== "system"
  );

  // Resolve thinking config: options take precedence over config-level setting
  const thinkingOpts = options.thinking ?? config.thinking;
  const thinkingEnabled = thinkingOpts?.enabled === true;
  const budgetTokens = thinkingOpts?.budgetTokens ?? 10000;

  // max_tokens must cover both thinking tokens and output tokens
  const maxTokens =
    options.maxTokens ?? config.maxTokens ?? (thinkingEnabled ? budgetTokens + 8192 : 16000);

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: anthropicMessages,
    stream: true,
  };

  if (thinkingEnabled) {
    // Extended thinking requires temperature=1 (Anthropic requirement)
    body.thinking = {
      type: "enabled",
      budget_tokens: budgetTokens,
    };
    body.temperature = 1;
  } else {
    body.temperature = options.temperature ?? config.temperature ?? 0.2;
  }

  // Anthropic native tool definitions
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools.map((t: ToolDefinition) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Anthropic request failed [model: ${config.model}] (${response.status}): ${text}`
    );
  }

  // Anthropic SSE format: each event is a pair of lines:
  //   event: <event_type>
  //   data: <json>
  //
  // We parse the raw SSE and look for content_block_delta events.
  // When extended thinking is enabled, the stream will also contain:
  //   - content_block_start with type "thinking" (we track but don't yield)
  //   - content_block_delta with type "thinking_delta" (we skip)
  //   - content_block_delta with type "text_delta" (we yield)
  if (!response.body) throw new Error("Anthropic response body is null");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  // Track whether current content block is a thinking block (to suppress output)
  let currentBlockIsThinking = false;
  // Anthropic reports stop_reason on the message_delta event, near the end of
  // the stream. We capture it and report it via onFinish on message_stop.
  let stopReason: string | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          const data = line.slice(6);

          if (currentEvent === "message_delta") {
            // Carries the final stop_reason for the message.
            try {
              const parsed = JSON.parse(data) as {
                delta?: { stop_reason?: string };
              };
              if (parsed.delta?.stop_reason) {
                stopReason = parsed.delta.stop_reason;
              }
            } catch {
              // Ignore malformed JSON
            }
          } else if (currentEvent === "content_block_start") {
            // Identify the block type so we know whether to suppress deltas
            try {
              const parsed = JSON.parse(data) as {
                content_block?: { type?: string };
              };
              currentBlockIsThinking =
                parsed.content_block?.type === "thinking";
            } catch {
              currentBlockIsThinking = false;
            }
          } else if (currentEvent === "content_block_stop") {
            currentBlockIsThinking = false;
          } else if (currentEvent === "content_block_delta") {
            if (currentBlockIsThinking) {
              // Thinking delta — track internally but do NOT yield to caller
              continue;
            }
            try {
              const parsed = JSON.parse(data) as {
                delta?: { type?: string; text?: string };
              };
              if (
                parsed.delta?.type === "text_delta" &&
                parsed.delta.text
              ) {
                yield parsed.delta.text;
              }
            } catch {
              // Ignore malformed JSON
            }
          } else if (currentEvent === "message_stop") {
            options.onFinish?.(stopReason);
            return;
          }
        }
      }
    }
    // Stream ended without an explicit message_stop event.
    options.onFinish?.(stopReason);
  } finally {
    reader.releaseLock();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude Code provider (subprocess)
//
// Used for the planner and verifier roles when provider is "claude-code".
// These roles only need a single text completion, so we flatten the
// conversation into one prompt and return the CLI's final result text.
// Tools default to read-only so these roles never mutate the working tree.
// The executor uses its own per-task path in executor.ts.
// ─────────────────────────────────────────────────────────────────────────────

function flattenForClaudeCode(messages: Message[]): string {
  return messages
    .map((m) => {
      if (m.role === "user") return m.content;
      if (m.role === "assistant") return `[you previously responded]\n${m.content}`;
      return `[tool result]\n${m.content}`;
    })
    .join("\n\n");
}

async function* chatStreamClaudeCode(
  config: RoleModelConfig,
  systemPrompt: string,
  messages: Message[],
  options: ChatOptions = {}
): AsyncGenerator<string> {
  const prompt = flattenForClaudeCode(messages);
  const result = await runClaudeCode({
    prompt,
    systemPrompt: systemPrompt || undefined,
    model: config.model,
    allowedTools: config.claudeCode?.allowedTools,
    // Read-only by default: planner/verifier inspect but never edit.
    disallowedTools:
      config.claudeCode?.disallowedTools ?? [
        "Write",
        "Edit",
        "MultiEdit",
        "NotebookEdit",
      ],
    dangerouslySkipPermissions:
      config.claudeCode?.dangerouslySkipPermissions ?? true,
    signal: options.signal,
  });
  if (result.text) yield result.text;
  // The subprocess only returns once its own agent loop has finished, so a
  // return is always a clean stop. (normalizeStopReason ignores the raw value
  // for claude-code, but we report one for symmetry.)
  options.onFinish?.("end_turn");
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool call parsing from accumulated text (freeform fallback)
//
// Used when native function calling is unavailable or as a fallback for
// local models that don't support the tools parameter.
// ─────────────────────────────────────────────────────────────────────────────

function parseToolCallsFromText(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const toolBlockRegex = /```tool\s*\n?([\s\S]*?)\n?```/g;
  let match;

  while ((match = toolBlockRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim()) as Record<string, unknown>;
      const name = parsed.name;
      if (name && typeof name === "string") {
        calls.push({
          id: `call_${calls.length}`,
          tool_name: name,
          arguments: extractToolArguments(parsed),
        });
      }
    } catch {
      // Skip malformed tool calls
    }
  }

  return calls;
}

/**
 * Pull tool arguments out of a parsed tool block, tolerating both the documented
 * shape `{"name","arguments":{...}}` and the common variant where models put the
 * args flat alongside `name` (e.g. `{"name":"read_file","path":"x"}`).
 */
export function extractToolArguments(
  parsed: Record<string, unknown>
): Record<string, unknown> {
  if (parsed.arguments && typeof parsed.arguments === "object") {
    return parsed.arguments as Record<string, unknown>;
  }
  const { name: _name, arguments: _args, ...rest } = parsed;
  return rest;
}

// ─────────────────────────────────────────────────────────────────────────────
// AbortSignal combiner helper
// ─────────────────────────────────────────────────────────────────────────────

function combineSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () =>
      controller.abort(signal.reason)
    );
  }
  return controller.signal;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Streaming chat — yields string chunks as they arrive from the model.
 *
 * Supports:
 *   - provider: "openai"   → OpenAI API with SSE streaming
 *   - provider: "anthropic" → Anthropic Messages API with SSE streaming
 *   - provider: "local"    → OpenAI-compatible endpoint (Ollama, LM Studio,
 *                            vLLM, llama.cpp) — same path as "openai" but with
 *                            a local baseUrl and no auth header.
 */
export async function* chatStream(
  config: RoleModelConfig,
  messages: Message[],
  options: ChatOptions = {}
): AsyncGenerator<string> {
  // Extract systemPrompt from messages if it's the first system message,
  // otherwise use empty string. The callers currently pass system prompts
  // separately; here we receive them as part of the messages array OR via the
  // options object. For compatibility we check if the first message is system.
  const firstMsg = messages[0];
  let systemPrompt = "";
  let chatMessages = messages;

  if (firstMsg && (firstMsg as { role: string }).role === "system") {
    systemPrompt = firstMsg.content;
    chatMessages = messages.slice(1);
  }

  if (config.provider === "anthropic") {
    yield* chatStreamAnthropic(config, systemPrompt, chatMessages, options);
  } else if (config.provider === "claude-code") {
    yield* chatStreamClaudeCode(config, systemPrompt, chatMessages, options);
  } else {
    // "openai" and "local" both use OpenAI-compatible API
    let cfg = config;
    if (config.provider === "openai" && !config.apiKey && process.env.OPENAI_API_KEY) {
      cfg = { ...config, apiKey: process.env.OPENAI_API_KEY };
    }
    yield* chatStreamOpenAI(cfg, systemPrompt, chatMessages, options);
  }
}

/**
 * Streaming chat with an explicit system prompt (separate from messages array).
 * Use this from executor/planner/verifier where the system prompt is built
 * independently and passed alongside the conversation history.
 */
export async function* chatStreamWithSystem(
  config: RoleModelConfig,
  systemPrompt: string,
  messages: Message[],
  options: ChatOptions = {}
): AsyncGenerator<string> {
  if (config.provider === "anthropic") {
    yield* chatStreamAnthropic(config, systemPrompt, messages, options);
  } else if (config.provider === "claude-code") {
    yield* chatStreamClaudeCode(config, systemPrompt, messages, options);
  } else {
    let cfg = config;
    if (config.provider === "openai" && !config.apiKey && process.env.OPENAI_API_KEY) {
      cfg = { ...config, apiKey: process.env.OPENAI_API_KEY };
    }
    yield* chatStreamOpenAI(cfg, systemPrompt, messages, options);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Local model health check
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check whether a local model server is reachable and lists available models.
 * Hits GET {baseUrl}/models and returns a simple ok/error result.
 */
export async function checkLocalModel(
  config: RoleModelConfig
): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  if (!config.baseUrl) {
    return {
      ok: false,
      error:
        "Local provider requires a baseUrl (e.g. http://localhost:11434/v1 for Ollama, http://localhost:1234/v1 for LM Studio)",
    };
  }

  try {
    const response = await fetch(`${config.baseUrl}/models`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        ok: false,
        error: `Server responded with ${response.status}: ${text}`,
      };
    }

    const data = (await response.json()) as {
      data?: Array<{ id?: string }>;
    };
    const models = (data.data ?? [])
      .map((m) => m.id ?? "")
      .filter((id) => id !== "");

    return { ok: true, models };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
      return {
        ok: false,
        error: `Could not connect to local model server at ${config.baseUrl}. Is the server running? (${msg})`,
      };
    }
    return { ok: false, error: msg };
  }
}

/**
 * Non-streaming convenience wrapper around chatStream.
 * Collects all chunks into a full string, then parses any tool calls.
 * Use this for planner/verifier where streaming doesn't improve UX.
 *
 * When native tool definitions are provided, the model will return structured
 * tool calls; these are passed through via parseToolCallsFromText as a
 * freeform fallback if needed.
 */
export async function chat(
  config: RoleModelConfig,
  systemPrompt: string,
  messages: Message[],
  options: ChatOptions = {}
): Promise<ChatResponse> {
  const chunks: string[] = [];

  for await (const chunk of chatStreamWithSystem(
    config,
    systemPrompt,
    messages,
    options
  )) {
    chunks.push(chunk);
  }

  const content = chunks.join("");
  const toolCalls = parseToolCallsFromText(content);

  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Config loading (keep existing logic, cleaned up)
// ─────────────────────────────────────────────────────────────────────────────

export async function loadConfig(): Promise<ModelConfig> {
  const candidates = [
    join(process.cwd(), "harness.config.json"),
    join(homedir(), ".config", "coding-harness", "config.json"),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
        const result = ModelConfigSchema.safeParse(raw);
        if (result.success) return result.data;
        throw new Error(`Invalid config at ${path}: ${result.error.message}`);
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("Invalid config")) {
          throw e;
        }
        throw new Error(`Failed to parse config at ${path}: ${String(e)}`);
      }
    }
  }

  throw new Error(
    `No config file found. Create harness.config.json in the project root or ~/.config/coding-harness/config.json`
  );
}
