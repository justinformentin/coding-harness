import type { Provider } from "./schemas.js";

/**
 * completion.ts — the single source of truth for "is the model done?".
 *
 * Two distinct notions live here, deliberately co-located so the reasoning is
 * in one place:
 *
 *   1. Turn termination — did the model stop generating this turn, and WHY?
 *      Derived from provider stop reasons (OpenAI/local `finish_reason`,
 *      Anthropic `stop_reason`, claude-code process exit). Fully deterministic.
 *
 *   2. Task completion — does the model claim it has finished the work?
 *      Signalled explicitly by the `finish` tool. Deterministic to *detect*
 *      (we parse the call), but never a guarantee the work is correct — that
 *      judgment belongs to the verifier, not here.
 *
 * The executor's completion loop combines the two: keep running turns until the
 * model either calls `finish` or cleanly stops with no work pending.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The explicit completion signal: the `finish` tool
// ─────────────────────────────────────────────────────────────────────────────

export const FINISH_TOOL_NAME = "finish";

// Appended to the executor system prompt so text-provider models know how to
// declare completion. The `finish` tool is a sentinel — it has no side effect
// and is NOT routed through executeTool; the executor loop detects the call and
// stops. Provider-agnostic: openai / anthropic / local all emit the same
// freeform ```tool block, so one description covers them all.
export const FINISH_TOOL_PROMPT = `### finish
Call this once you have done everything you can on the checklist. Calling it ends your turn, so only call it when you are genuinely done — not after a single step.
Parameters:
  - summary (string, required): one or two sentences on what you accomplished
  - completedItems (string[], required): the ids of the checklist items you completed this run`;

export type FinishCall = {
  summary: string;
  completedItems: string[];
};

// Pull a finish() call out of a turn's parsed tool calls, if one is present.
// Tolerates a missing/garbled payload — an empty completedItems list still
// counts as "the model declared it's done", just with no per-item claims.
export function parseFinishCall(
  toolCalls: { name: string; arguments: Record<string, unknown> }[]
): FinishCall | null {
  const call = toolCalls.find((t) => t.name === FINISH_TOOL_NAME);
  if (!call) return null;
  const args = call.arguments ?? {};
  return {
    summary: typeof args.summary === "string" ? args.summary : "",
    completedItems: Array.isArray(args.completedItems)
      ? args.completedItems.filter((x): x is string => typeof x === "string")
      : [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Turn termination: normalized stop reasons
// ─────────────────────────────────────────────────────────────────────────────

// Every provider's raw finish_reason / stop_reason mapped onto one vocabulary
// so the loop logic never has to branch on provider.
export type StopReason =
  | "stop" // model chose to end its turn naturally
  | "tool_use" // model paused to call tools and expects to continue
  | "truncated" // hit the token cap mid-output — NOT actually finished
  | "unknown"; // provider didn't tell us (common on local servers)

// Map a raw provider stop reason onto the normalized StopReason. Each provider
// uses different strings, so this is the one place that knows their dialects.
export function normalizeStopReason(
  provider: Provider,
  raw: string | undefined
): StopReason {
  if (!raw) return "unknown";

  // Anthropic: stop_reason on the message_delta event.
  if (provider === "anthropic") {
    switch (raw) {
      case "end_turn":
      case "stop_sequence":
      case "refusal":
        return "stop";
      case "tool_use":
      case "pause_turn":
        return "tool_use";
      case "max_tokens":
        return "truncated";
      default:
        return "unknown";
    }
  }

  // claude-code: the subprocess only returns once its own agent loop has
  // finished, so a return always means a clean stop regardless of `raw`.
  if (provider === "claude-code") {
    return "stop";
  }

  // openai + local (OpenAI-compatible): choices[].finish_reason.
  switch (raw) {
    case "stop":
      return "stop";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "truncated";
    default:
      return "unknown";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The decision: should the execute-to-completion loop stop after this turn?
// ─────────────────────────────────────────────────────────────────────────────

export type TurnSummary = {
  // Number of *non-finish* tool calls the model made this turn.
  toolCallCount: number;
  // Whether the model called the `finish` tool this turn.
  finishCalled: boolean;
  // Normalized stop reason for this turn.
  stopReason: StopReason;
};

export type DoneDecision = {
  done: boolean;
  // Human-readable so the harness/log can explain WHY the loop stopped or
  // continued, rather than the loop's behaviour being opaque.
  reason: string;
  // True when we're stopping on a soft signal (model went quiet without calling
  // finish) rather than the explicit one. Lets the caller flag the uncertainty.
  implicit?: boolean;
};

// Decide whether the loop should stop. Order matters:
//   1. An explicit finish() always wins — that's the signal we want.
//   2. Otherwise keep going while real work is in flight (tool calls).
//   3. Keep going if the output was merely truncated (cut off mid-thought).
//   4. A clean stop with nothing pending ends the loop, but only implicitly —
//      the model went quiet without declaring done, so the caller should treat
//      the result with more suspicion than an explicit finish.
export function decideExecutorDone(turn: TurnSummary): DoneDecision {
  if (turn.finishCalled) {
    return { done: true, reason: "executor called finish" };
  }
  if (turn.toolCallCount > 0) {
    return {
      done: false,
      reason: "tool calls pending — running them and continuing",
    };
  }
  if (turn.stopReason === "truncated") {
    return {
      done: false,
      reason: "output truncated at token cap — continuing",
    };
  }
  return {
    done: true,
    reason: "model stopped without calling finish",
    implicit: true,
  };
}
