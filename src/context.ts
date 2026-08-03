import type { HarnessState, Message, PlannerChecklistItem } from "./schemas.js";

export type ContextLimits = { maxMessages: number; maxBytes: number };
export type StepContext = {
  messages: Message[];
  retainedHistory: Message[];
  compacted: Message[];
  byteLength: number;
};

export function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Length(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Length(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

export function buildStepContext(
  state: HarnessState,
  item: PlannerChecklistItem,
  limits: ContextLimits,
): StepContext {
  const feedback = state.verifierReport?.incompleteItems.includes(item.id)
    ? state.verifierReport.missingEvidence.filter((entry) =>
        entry.includes(item.id),
      )
    : [];
  const baseText = [
    ...(state.contextArtifacts[item.id] ?? []).map(
      (artifact) => `Compacted context artifact: ${artifact}`,
    ),
    `Overall task: ${state.originalPrompt}`,
    `Current step (${item.id}): ${item.description}`,
    `Acceptance criteria: ${item.acceptanceCriteria.join("; ")}`,
    `Workspace files changed: ${state.artifacts.filesChanged.join(", ") || "none"}`,
    feedback.length ? `Previous verifier feedback: ${feedback.join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const base: Message = {
    role: "user",
    content: truncateUtf8(baseText, Math.max(0, limits.maxBytes - 128)),
  };
  const history = [...(state.stepMessages[item.id] ?? [])];
  const retained = [...history];
  const compacted: Message[] = [];
  let messages = [base, ...retained];
  let bytes = utf8Length(JSON.stringify(messages));
  while (
    retained.length > 0 &&
    (messages.length > limits.maxMessages || bytes > limits.maxBytes)
  ) {
    compacted.push(retained.shift()!);
    messages = [base, ...retained];
    bytes = utf8Length(JSON.stringify(messages));
  }
  if (bytes > limits.maxBytes) {
    const overhead = utf8Length(JSON.stringify([{ ...base, content: "" }]));
    base.content = truncateUtf8(
      base.content,
      Math.max(0, limits.maxBytes - overhead),
    );
    messages = [base];
    bytes = utf8Length(JSON.stringify(messages));
  }
  return { messages, retainedHistory: retained, compacted, byteLength: bytes };
}
