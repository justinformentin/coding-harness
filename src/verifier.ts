import { existsSync, readFileSync } from "fs";
import { chat } from "./llm.js";
import { verifierSystemPrompt } from "./prompts.js";
import {
  type HarnessState,
  type PlannerChecklistItem,
  type VerificationKind,
  type VerifierReport,
  type RoleModelConfig,
} from "./schemas.js";

/**
 * Verification, restructured to be deterministic-first and LLM-rare.
 *
 * Every checklist item resolves to one of three verification kinds, and each is
 * decided as cheaply as possible:
 *
 *   - deterministic → pure code: file exists, command ran, pattern present.
 *     Never touches an LLM.
 *   - manual        → non-deterministic content we can't judge mechanically.
 *     We only confirm the WORK WAS DONE (the executor's finish claim) and defer
 *     content judgment to a later human review. Never touches an LLM.
 *   - llm           → genuinely needs semantic judgment now. Judged per-item
 *     with a minimal payload (just that item + relevant artifacts), not the
 *     whole-run dump the old verifier sent on every iteration.
 *
 * The common case — a plan full of deterministic items — never calls the
 * verifier model at all.
 */
export async function verify(
  state: HarnessState,
  config: RoleModelConfig
): Promise<VerifierReport> {
  const completed: string[] = [];
  const incomplete: string[] = [];
  const missing: string[] = [];
  // Items needing semantic judgment are collected and judged after the cheap
  // checks, so we only spin up the model when something actually requires it.
  const llmItems: PlannerChecklistItem[] = [];

  for (const item of state.checklist) {
    if (item.status === "done") {
      completed.push(item.id);
      continue;
    }

    switch (resolveVerificationKind(item)) {
      case "deterministic": {
        const result = checkDeterministic(item, state);
        if (result.passed) {
          completed.push(item.id);
        } else {
          incomplete.push(item.id);
          missing.push(...result.missing);
        }
        break;
      }
      case "manual": {
        // No content check — pass iff the executor declared this item done.
        if (state.executorClaims.includes(item.id)) {
          completed.push(item.id);
        } else {
          incomplete.push(item.id);
          missing.push(
            `${item.id}: executor has not reported this item complete yet`
          );
        }
        break;
      }
      case "llm":
        llmItems.push(item);
        break;
    }
  }

  // Only now — and only if some item truly needs it — call the model.
  for (const item of llmItems) {
    const verdict = await judgeItemWithLLM(item, state, config);
    if (verdict.complete) {
      completed.push(item.id);
    } else {
      incomplete.push(item.id);
      missing.push(...verdict.missing.map((m) => `${item.id}: ${m}`));
    }
  }

  const done =
    incomplete.length === 0 &&
    state.checklist.every((item) => completed.includes(item.id));

  return {
    done,
    completedItems: completed,
    incompleteItems: incomplete,
    missingEvidence: missing,
    nextInstruction: done
      ? ""
      : missing.length > 0
        ? `Address the following: ${missing.join("; ")}`
        : "Continue working on the incomplete items.",
  };
}

// Resolve an item's verification kind. The planner usually sets it explicitly;
// when it doesn't, infer: deterministic if there's a non-empty verifierConfig,
// otherwise manual. (We never infer "llm" — that must be opted into.)
function resolveVerificationKind(
  item: PlannerChecklistItem
): VerificationKind {
  if (item.verificationKind) return item.verificationKind;
  return hasDeterministicChecks(item) ? "deterministic" : "manual";
}

function hasDeterministicChecks(item: PlannerChecklistItem): boolean {
  const c = item.verifierConfig;
  if (!c) return false;
  return [
    c.requiredFiles,
    c.requiredCommands,
    c.requiredPatterns,
    c.forbiddenPatterns,
    c.successIndicators,
  ].some((arr) => arr !== undefined && arr.length > 0);
}

// Run a single item's deterministic checks against the working tree and the
// artifacts the executor produced. Pure code — no LLM, no network.
function checkDeterministic(
  item: PlannerChecklistItem,
  state: HarnessState
): { passed: boolean; missing: string[] } {
  const missing: string[] = [];
  const config = item.verifierConfig;

  // An item marked deterministic but lacking any checks can't be proven; treat
  // it as failing with a clear message so the plan gets fixed rather than
  // silently passing.
  if (!config || !hasDeterministicChecks(item)) {
    return {
      passed: false,
      missing: [`${item.id}: marked deterministic but has no verifierConfig checks`],
    };
  }

  // Required files must exist on disk.
  for (const file of config.requiredFiles ?? []) {
    if (!existsSync(file)) {
      missing.push(`File not found: ${file} (required by ${item.id})`);
    }
  }

  // Required commands must appear in the commands the executor actually ran.
  for (const cmd of config.requiredCommands ?? []) {
    const wasRun = state.artifacts.commandsRun.some((c) => c.includes(cmd));
    if (!wasRun) {
      missing.push(`Command not run: "${cmd}" (required by ${item.id})`);
    }
  }

  // Required patterns must appear in a changed file or in command output.
  for (const pattern of config.requiredPatterns ?? []) {
    const regex = new RegExp(pattern);
    const foundInFiles = state.artifacts.filesChanged.some((f) => {
      try {
        return regex.test(readFileSync(f, "utf-8"));
      } catch {
        return false;
      }
    });
    const foundInOutput = state.artifacts.commandOutputs.some((o) =>
      regex.test(o)
    );
    if (!foundInFiles && !foundInOutput) {
      missing.push(`Pattern not found: "${pattern}" (required by ${item.id})`);
    }
  }

  // Forbidden patterns must NOT appear in any changed file.
  for (const pattern of config.forbiddenPatterns ?? []) {
    const regex = new RegExp(pattern, "i");
    for (const file of state.artifacts.filesChanged) {
      try {
        if (regex.test(readFileSync(file, "utf-8"))) {
          missing.push(
            `Forbidden pattern found: "${pattern}" in ${file} (violation in ${item.id})`
          );
        }
      } catch {
        // file unreadable, skip
      }
    }
  }

  // Success indicators must appear in some command's output.
  for (const indicator of config.successIndicators ?? []) {
    const found = state.artifacts.commandOutputs.some((o) =>
      o.includes(indicator)
    );
    if (!found) {
      missing.push(
        `Success indicator not found in output: "${indicator}" (required by ${item.id})`
      );
    }
  }

  return { passed: missing.length === 0, missing };
}

// Judge a single "llm" item from a minimal payload: just the item and the
// artifacts (with command outputs trimmed) — not the whole run. Falls back to
// "incomplete" if the model returns something unparseable, so a flaky judge
// never spuriously marks work done.
async function judgeItemWithLLM(
  item: PlannerChecklistItem,
  state: HarnessState,
  config: RoleModelConfig
): Promise<{ complete: boolean; missing: string[] }> {
  const payload = {
    item: {
      id: item.id,
      description: item.description,
      acceptanceCriteria: item.acceptanceCriteria,
      evidenceRequired: item.evidenceRequired,
    },
    artifacts: {
      filesChanged: state.artifacts.filesChanged,
      commandsRun: state.artifacts.commandsRun,
      // Trim outputs so the payload stays small even on chatty commands.
      commandOutputs: state.artifacts.commandOutputs.map((o) =>
        o.length > 1000 ? o.slice(0, 1000) + "…[truncated]" : o
      ),
    },
  };

  const { content } = await chat(config, verifierSystemPrompt(), [
    { role: "user", content: JSON.stringify(payload) },
  ]);

  const jsonStr = content.match(/\{[\s\S]*\}/)?.[0] ?? content;
  try {
    const parsed = JSON.parse(jsonStr) as {
      complete?: unknown;
      missingEvidence?: unknown;
    };
    if (typeof parsed.complete === "boolean") {
      const missingEvidence = Array.isArray(parsed.missingEvidence)
        ? parsed.missingEvidence.filter((x): x is string => typeof x === "string")
        : [];
      return {
        complete: parsed.complete,
        missing: parsed.complete ? [] : missingEvidence.length > 0 ? missingEvidence : ["acceptance criteria not yet met"],
      };
    }
  } catch {
    // fall through
  }

  return {
    complete: false,
    missing: ["verifier could not parse the judge's response"],
  };
}
