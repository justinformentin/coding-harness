import type { Message, RoleModelConfig } from "./schemas.js";

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

async function chatOpenAI(
  config: RoleModelConfig,
  systemPrompt: string,
  messages: Message[]
): Promise<string> {
  const baseUrl =
    config.baseUrl ||
    (config.provider === "openai"
      ? "https://api.openai.com/v1"
      : "http://localhost:11434/v1");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;

  const llmMessages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    ...convertMessages(messages),
  ];

  const body: Record<string, unknown> = {
    model: config.model,
    messages: llmMessages,
    temperature: config.temperature ?? 0.2,
  };

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM request failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string | null } }>;
  };
  return data.choices[0].message.content || "";
}

async function chatAnthropic(
  config: RoleModelConfig,
  systemPrompt: string,
  messages: Message[]
): Promise<string> {
  const baseUrl = config.baseUrl || "https://api.anthropic.com";
  const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey)
    throw new Error("ANTHROPIC_API_KEY is required for Anthropic provider");

  const anthropicMessages = convertMessages(messages).filter(
    (m) => m.role !== "system"
  );

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 8192,
      system: systemPrompt,
      messages: anthropicMessages,
      temperature: config.temperature ?? 0.2,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic request failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text: string }>;
  };
  const textBlock = data.content?.find((b) => b.type === "text");
  return textBlock?.text || "";
}

export async function chat(
  config: RoleModelConfig,
  systemPrompt: string,
  messages: Message[]
): Promise<string> {
  if (config.provider === "anthropic") {
    return chatAnthropic(config, systemPrompt, messages);
  }
  // "openai" and "local" both use OpenAI-compatible API
  let cfg = config;
  if (config.provider === "openai" && !config.apiKey) {
    cfg = { ...config, apiKey: process.env.OPENAI_API_KEY };
  }
  return chatOpenAI(cfg, systemPrompt, messages);
}
