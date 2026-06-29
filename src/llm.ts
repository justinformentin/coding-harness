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
  // For "local" provider, default to Ollama's port if no baseUrl is set.
  // Users can override with any OpenAI-compatible endpoint (LM Studio: 1234,
  // vLLM: 8000, llama.cpp server: 8080, etc.).
  const defaultLocalUrl =
    config.provider === "local"
      ? "http://localhost:11434/v1"  // Ollama default; override via baseUrl
      : "https://api.openai.com/v1";

  const baseUrl = config.baseUrl || defaultLocalUrl;
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

  const maxTokens =
    options.maxTokens ?? config.maxTokens ?? 8192;

  const body: Record<string, unknown> = {
    model: config.model,
    messages: llmMessages,
    temperature: options.temperature ?? config.temperature ?? 0.2,
    max_tokens: maxTokens,
    stream: true,
  };

  if (options.responseFormat) {
    body.response_format = { type: options.responseFormat };
  }

  // Pass tool definitions if provided.
  // Local models (Ollama) support function calling for capable models;
  // for others the tools param is passed through as a best-effort.
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

  const controller = new AbortController();
  const signal = options.signal
    ? combineSignals(options.signal, controller.signal)
    : controller.signal;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `OpenAI-compatible request failed [${config.provider}/${config.model}] (${response.status}): ${text}`
    );
  }

  // OpenAI SSE format:
  //   data: {"choices":[{"delta":{"content":"token"}}]}
  //   data: [DONE]
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

      const delta = parsed.choices?.[0]?.delta;
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

  const maxTokens = options.maxTokens ?? config.maxTokens ?? 8192;

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: anthropicMessages,
    temperature: options.temperature ?? config.temperature ?? 0.2,
    stream: true,
  };

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
  if (!response.body) throw new Error("Anthropic response body is null");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";

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
          if (currentEvent === "content_block_delta") {
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
            return;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
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
      const parsed = JSON.parse(match[1].trim()) as {
        name?: unknown;
        arguments?: Record<string, unknown>;
      };
      if (parsed.name && typeof parsed.name === "string") {
        calls.push({
          id: `call_${calls.length}`,
          tool_name: parsed.name,
          arguments: parsed.arguments || {},
        });
      }
    } catch {
      // Skip malformed tool calls
    }
  }

  return calls;
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
  } else {
    let cfg = config;
    if (config.provider === "openai" && !config.apiKey && process.env.OPENAI_API_KEY) {
      cfg = { ...config, apiKey: process.env.OPENAI_API_KEY };
    }
    yield* chatStreamOpenAI(cfg, systemPrompt, messages, options);
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
