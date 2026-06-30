import { chat } from "./llm.js";
import { plannerSystemPrompt } from "./prompts.js";
import {
  PlannerOutputSchema,
  type PlannerChecklistItem,
  type RoleModelConfig,
  type Message,
} from "./schemas.js";

// How many times to re-prompt the planner when it returns something that
// isn't valid JSON matching the schema. Models (especially ones without a
// JSON mode) sometimes reply conversationally — asking to explore the repo,
// wrapping output in prose, etc. A corrective follow-up usually fixes it.
const MAX_PLAN_ATTEMPTS = 3;

export async function plan(
  prompt: string,
  config: RoleModelConfig
): Promise<PlannerChecklistItem[]> {
  const messages: Message[] = [{ role: "user", content: prompt }];
  let lastError = "";

  for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt++) {
    const { content } = await chat(config, plannerSystemPrompt(), messages, {
      // Hint JSON mode to providers that support it (OpenAI, JSON-capable
      // local models). Providers that don't (e.g. Anthropic) ignore this.
      responseFormat: "json_object",
    });

    const parsed = parsePlannerOutput(content);
    if (parsed.ok) {
      // Ensure all items start as pending with empty evidenceFound
      return parsed.value.checklist.map((item) => ({
        ...item,
        status: "pending" as const,
        evidenceFound: [],
      }));
    }

    lastError = parsed.error;

    // Feed the bad response back and ask the model to correct itself.
    if (attempt < MAX_PLAN_ATTEMPTS) {
      messages.push({ role: "assistant", content });
      messages.push({
        role: "user",
        content:
          `That response was not accepted: ${parsed.error}\n\n` +
          `You have no tools and cannot inspect the repository — do not ask ` +
          `questions or request to explore. Reply with ONLY a single valid ` +
          `JSON object matching the required schema. The first character of ` +
          `your reply must be "{". Output nothing else.`,
      });
    }
  }

  throw new Error(
    `Planner failed to produce valid JSON after ${MAX_PLAN_ATTEMPTS} attempts. ` +
      `Last error: ${lastError}`
  );
}

type ParseResult =
  | { ok: true; value: { goal: string; checklist: PlannerChecklistItem[] } }
  | { ok: false; error: string };

function parsePlannerOutput(content: string): ParseResult {
  const jsonStr = extractJSON(content);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    const preview = content.trim().slice(0, 200);
    return {
      ok: false,
      error: `response was not valid JSON (got: "${preview}${
        content.length > 200 ? "…" : ""
      }")`,
    };
  }

  const result = PlannerOutputSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: `JSON did not match the required schema: ${result.error.message}`,
    };
  }

  return { ok: true, value: result.data };
}

function extractJSON(text: string): string {
  // Try to find JSON in code blocks first
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();

  // Try to find raw JSON object
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) return jsonMatch[0];

  return text.trim();
}
