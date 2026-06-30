import { chat } from "./llm.js";
import { plannerSystemPrompt } from "./prompts.js";
import { executeTool } from "./tools.js";
import {
  PlannerOutputSchema,
  type PlannerChecklistItem,
  type RoleModelConfig,
  type Message,
} from "./schemas.js";

// How many times to re-prompt the planner when it returns something that
// isn't valid JSON matching the schema. Models (especially ones without a
// JSON mode) sometimes reply conversationally — wrapping output in prose, etc.
// A corrective follow-up usually fixes it.
const MAX_PLAN_ATTEMPTS = 3;

// How many read-only exploration turns the planner may take before it must
// commit to a plan. Each turn is one LLM round-trip that issued tool calls.
const MAX_EXPLORE_TURNS = 12;

// Cap each tool result fed back into the conversation so a large file or
// directory listing can't blow up the planner's context.
const MAX_TOOL_OUTPUT = 4000;

export async function plan(
  prompt: string,
  config: RoleModelConfig
): Promise<PlannerChecklistItem[]> {
  // Claude Code uses its own native tools; every other provider explores via
  // freeform ```tool blocks that we execute here.
  const freeformTools = config.provider !== "claude-code";
  const systemPrompt = plannerSystemPrompt({ freeformTools });

  const messages: Message[] = [{ role: "user", content: prompt }];
  let lastError = "";
  let exploreTurns = 0;
  let parseAttempts = 0;

  // Bound total round-trips: exploration turns plus a few attempts to coerce
  // valid JSON once exploration is done.
  for (let turn = 0; turn < MAX_EXPLORE_TURNS + MAX_PLAN_ATTEMPTS; turn++) {
    const { content, toolCalls } = await chat(config, systemPrompt, messages);

    // Exploration: if the model issued tool calls (and it still has budget),
    // run them read-only and feed the results back for another turn.
    if (
      freeformTools &&
      toolCalls &&
      toolCalls.length > 0 &&
      exploreTurns < MAX_EXPLORE_TURNS
    ) {
      exploreTurns++;

      // Push back ONLY the tool calls, not the model's prose. Models often
      // hallucinate the tool's output inline after emitting the call; storing
      // that fabricated text would poison later turns. We replace it with the
      // real results below.
      const cleanAssistant = toolCalls
        .map(
          (tc) =>
            "```tool\n" +
            JSON.stringify({ name: tc.tool_name, arguments: tc.arguments }) +
            "\n```"
        )
        .join("\n");
      messages.push({ role: "assistant", content: cleanAssistant });

      if (process.env.HARNESS_DEBUG_PLANNER) {
        console.error(
          `[planner] turn ${exploreTurns}: ${toolCalls
            .map((t) => `${t.tool_name}(${JSON.stringify(t.arguments)})`)
            .join(", ")}`
        );
      }

      const outputs: string[] = [];
      for (const tc of toolCalls) {
        // Guard against the model trying a mutating tool during planning.
        if (!READ_ONLY.has(tc.tool_name)) {
          outputs.push(
            `[${tc.tool_name}] ERROR: not available while planning (read-only). Plan the change instead.`
          );
          continue;
        }
        const result = await executeTool(tc.tool_name, tc.arguments);
        const output =
          result.output.length > MAX_TOOL_OUTPUT
            ? result.output.slice(0, MAX_TOOL_OUTPUT) + "\n…(truncated)"
            : result.output;
        outputs.push(`[${tc.tool_name}] ${result.success ? "OK" : "ERROR"}: ${output}`);
      }
      messages.push({ role: "tool", content: outputs.join("\n\n") });
      continue;
    }

    // No (more) tool calls — treat this as the final plan.
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
    parseAttempts++;
    if (parseAttempts >= MAX_PLAN_ATTEMPTS) break;

    // Feed the bad response back and ask the model to correct itself.
    messages.push({ role: "assistant", content });
    messages.push({
      role: "user",
      content:
        `That response was not accepted: ${parsed.error}\n\n` +
        `You are now done exploring. Reply with ONLY a single valid JSON ` +
        `object matching the required schema. The first character of your ` +
        `reply must be "{". Output nothing else.`,
    });
  }

  throw new Error(
    `Planner failed to produce valid JSON after ${parseAttempts} attempt(s). ` +
      `Last error: ${lastError}`
  );
}

const READ_ONLY = new Set(["read_file", "list_files", "grep", "git_diff"]);

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
