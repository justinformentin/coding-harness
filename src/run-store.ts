import {
  mkdir,
  writeFile,
  readFile,
  readdir,
  appendFile,
} from "fs/promises";
import { join } from "path";
import type { HarnessState, ModelConfig, VerifierReport } from "./schemas.js";

const RUNS_DIR = ".runs";

export async function saveRunInit(
  state: HarnessState,
  config: ModelConfig
): Promise<void> {
  const dir = join(RUNS_DIR, state.runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "prompt.md"), state.originalPrompt, "utf-8");
  await writeFile(
    join(dir, "config.json"),
    JSON.stringify(config, null, 2),
    "utf-8"
  );
}

export async function savePlanMarkdown(state: HarnessState): Promise<string> {
  const dir = join(RUNS_DIR, state.runId);
  await mkdir(dir, { recursive: true });

  // Derive a brief goal summary from the prompt (first sentence / 80 chars)
  const goalSummary =
    state.originalPrompt.split(/[.\n]/)[0].trim().slice(0, 80) ||
    state.originalPrompt.slice(0, 80);

  const lines: string[] = [`# Plan: ${goalSummary}`, "", "## Checklist", ""];

  for (let idx = 0; idx < state.checklist.length; idx++) {
    const item = state.checklist[idx];
    lines.push(`### ${idx + 1}. ${item.id}`);
    lines.push(`**Description:** ${item.description}`, "");

    lines.push("**Acceptance Criteria:**");
    if (item.acceptanceCriteria.length > 0) {
      for (const c of item.acceptanceCriteria) {
        lines.push(`- ${c}`);
      }
    } else {
      lines.push("- (none)");
    }
    lines.push("");

    lines.push("**Evidence Required:**");
    if (item.evidenceRequired.length > 0) {
      for (const e of item.evidenceRequired) {
        lines.push(`- ${e}`);
      }
    } else {
      lines.push("- (none)");
    }
    lines.push("");

    if (item.suggestedCommands && item.suggestedCommands.length > 0) {
      lines.push("**Suggested Commands:**");
      for (const cmd of item.suggestedCommands) {
        lines.push(`- \`${cmd}\``);
      }
      lines.push("");
    }

    if (item.verifierConfig) {
      const vc = item.verifierConfig;
      lines.push("**Verifier Config:**");
      lines.push(
        `- Required files: ${vc.requiredFiles?.join(", ") || "(none)"}`
      );
      lines.push(
        `- Required commands: ${vc.requiredCommands?.join(", ") || "(none)"}`
      );
      lines.push(
        `- Forbidden patterns: ${vc.forbiddenPatterns?.join(", ") || "(none)"}`
      );
      lines.push("");
    }

    lines.push("---", "");
  }

  const planPath = join(dir, "plan.md");
  await writeFile(planPath, lines.join("\n"), "utf-8");
  return planPath;
}

export async function saveChecklist(state: HarnessState): Promise<void> {
  const dir = join(RUNS_DIR, state.runId);
  await writeFile(
    join(dir, "checklist.json"),
    JSON.stringify(state.checklist, null, 2),
    "utf-8"
  );
}

export async function saveStateCheckpoint(
  state: HarnessState
): Promise<void> {
  const dir = join(RUNS_DIR, state.runId);
  await writeFile(
    join(dir, "state.json"),
    JSON.stringify(state, null, 2),
    "utf-8"
  );
}

export async function appendIteration(
  state: HarnessState,
  iterationData: Record<string, unknown>
): Promise<void> {
  const dir = join(RUNS_DIR, state.runId);
  const line = JSON.stringify({
    iteration: state.iteration,
    timestamp: Date.now(),
    ...iterationData,
  });
  await appendFile(join(dir, "iterations.jsonl"), line + "\n", "utf-8");
}

export async function appendVerifierReport(
  state: HarnessState,
  report: VerifierReport
): Promise<void> {
  const dir = join(RUNS_DIR, state.runId);
  const line = JSON.stringify({
    iteration: state.iteration,
    timestamp: Date.now(),
    ...report,
  });
  await appendFile(
    join(dir, "verifier-reports.jsonl"),
    line + "\n",
    "utf-8"
  );
}

export async function appendCommand(
  state: HarnessState,
  command: string,
  output: string
): Promise<void> {
  const dir = join(RUNS_DIR, state.runId);
  const line = JSON.stringify({
    iteration: state.iteration,
    timestamp: Date.now(),
    command,
    output: output.slice(0, 5000),
  });
  await appendFile(join(dir, "commands.jsonl"), line + "\n", "utf-8");
}

export async function loadState(runId: string): Promise<HarnessState> {
  const dir = join(RUNS_DIR, runId);
  const raw = await readFile(join(dir, "state.json"), "utf-8");
  return JSON.parse(raw) as HarnessState;
}

export async function listRuns(): Promise<string[]> {
  try {
    const entries = await readdir(RUNS_DIR);
    return entries.sort().reverse();
  } catch {
    return [];
  }
}
