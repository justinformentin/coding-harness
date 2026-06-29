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
