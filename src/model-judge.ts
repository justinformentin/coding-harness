import { z } from "zod";
import { chat } from "./llm.js";
import type { Message, ModelTrace, RoleModelConfig } from "./schemas.js";

const DecisionSchema = z
  .object({
    passed: z.boolean(),
    rationale: z.string().min(1),
    evidenceIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type ModelJudgeDecision = z.infer<typeof DecisionSchema> & {
  confidence: "model";
};

export type ModelJudgeCallbacks = {
  signal?: AbortSignal;
  onModelTrace?: (trace: ModelTrace) => void;
  onParseFailure?: (failure: {
    role: "verifier";
    attempt: number;
    error: string;
    text: string;
  }) => Promise<void>;
};

export async function judgeWithModel(
  config: RoleModelConfig,
  input: { rubric: string; evidence: Record<string, string> },
  callbacks: ModelJudgeCallbacks = {},
): Promise<ModelJudgeDecision> {
  const allowed = new Set(Object.keys(input.evidence));
  const messages: Message[] = [
    {
      role: "user" as const,
      content: JSON.stringify(input),
    },
  ];
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await chat(
      config,
      `Judge the rubric using only the supplied evidence IDs. Return strict JSON: {"passed":boolean,"rationale":string,"evidenceIds":string[]}. Claims outside supplied evidence are invalid.`,
      messages,
      {
        responseFormat: "json_object",
        signal: callbacks.signal,
        onTrace: callbacks.onModelTrace,
      },
    );
    try {
      const parsed = DecisionSchema.parse(JSON.parse(result.text.trim()));
      if (parsed.evidenceIds.some((id) => !allowed.has(id)))
        throw new Error("decision cited an unavailable evidence ID");
      return { ...parsed, confidence: "model" };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await callbacks.onParseFailure?.({
        role: "verifier",
        attempt,
        error: lastError,
        text: result.text,
      });
      messages.push({ role: "assistant", content: result.text });
      messages.push({
        role: "user",
        content: `Repair the JSON. Error: ${lastError}. Return only the strict object.`,
      });
    }
  }
  throw new Error(`Model judge failed structured output repair: ${lastError}`);
}
