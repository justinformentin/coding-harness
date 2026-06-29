import { chat } from "./llm.js";
import { plannerSystemPrompt } from "./prompts.js";
import {
  PlannerOutputSchema,
  type PlannerChecklistItem,
  type RoleModelConfig,
  type Message,
} from "./schemas.js";

export async function plan(
  prompt: string,
  config: RoleModelConfig
): Promise<PlannerChecklistItem[]> {
  const messages: Message[] = [{ role: "user", content: prompt }];
  const response = await chat(config, plannerSystemPrompt(), messages);

  // Extract JSON from response (model might wrap it in markdown code blocks)
  const jsonStr = extractJSON(response);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(
      `Planner returned invalid JSON: ${response.slice(0, 200)}...`
    );
  }

  const result = PlannerOutputSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Planner output doesn't match schema: ${result.error.message}`
    );
  }

  // Ensure all items start as pending with empty evidenceFound
  return result.data.checklist.map((item) => ({
    ...item,
    status: "pending" as const,
    evidenceFound: [],
  }));
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
