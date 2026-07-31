import { mkdir, writeFile, readFile, readdir, appendFile } from "fs/promises";
import { join } from "path";
import { HarnessStateSchema } from "./schemas.js";
import type {
  HarnessState,
  ResolvedConfig,
  VerifierReport,
} from "./schemas.js";
import type { HarnessEvent } from "./harness.js";
import { redactConfig } from "./config.js";

const RUNS_DIR = ".runs";

export async function saveRunInit(
  state: HarnessState,
  config: ResolvedConfig,
): Promise<void> {
  const dir = join(RUNS_DIR, state.runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "prompt.md"), state.originalPrompt, "utf-8");
  const redacted = JSON.stringify(redactConfig(config), null, 2);
  await writeFile(join(dir, "config.resolved.json"), redacted, "utf-8");
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
        `- Required files: ${vc.requiredFiles?.join(", ") || "(none)"}`,
      );
      lines.push(
        `- Required commands: ${vc.requiredCommands?.join(", ") || "(none)"}`,
      );
      lines.push(
        `- Forbidden patterns: ${vc.forbiddenPatterns?.join(", ") || "(none)"}`,
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
    "utf-8",
  );
}

export async function saveStateCheckpoint(state: HarnessState): Promise<void> {
  const dir = join(RUNS_DIR, state.runId);
  await writeFile(
    join(dir, "state.json"),
    JSON.stringify(state, null, 2),
    "utf-8",
  );
}

export async function appendIteration(
  state: HarnessState,
  iterationData: Record<string, unknown>,
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
  report: VerifierReport,
): Promise<void> {
  const dir = join(RUNS_DIR, state.runId);
  const line = JSON.stringify({
    iteration: state.iteration,
    timestamp: Date.now(),
    ...report,
  });
  await appendFile(join(dir, "verifier-reports.jsonl"), line + "\n", "utf-8");
}

export async function appendCommand(
  state: HarnessState,
  command: string,
  output: string,
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

// Durable transcript of every harness event, in order. This is the persistent
// record of what the TUI showed — assistant text, tool calls, tool results,
// verifier reports — so a resumed run can rebuild the full log rather than
// starting with a blank screen. Appends are serialized through a single promise
// chain so concurrent emits can't interleave a half-written line.
let eventAppendChain: Promise<void> = Promise.resolve();

export function appendEvent(runId: string, event: HarnessEvent): Promise<void> {
  eventAppendChain = eventAppendChain
    .then(() =>
      appendFile(
        join(RUNS_DIR, runId, "events.jsonl"),
        JSON.stringify({ timestamp: Date.now(), event }) + "\n",
        "utf-8",
      ),
    )
    .catch(() => {
      // Best-effort: a failed transcript append must never break the run.
    });
  return eventAppendChain;
}

export async function loadEvents(runId: string): Promise<HarnessEvent[]> {
  try {
    const raw = await readFile(join(RUNS_DIR, runId, "events.jsonl"), "utf-8");
    const events: HarnessEvent[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as { event?: HarnessEvent };
        if (parsed.event) events.push(parsed.event);
      } catch {
        // Skip a malformed / partially-written line.
      }
    }
    return events;
  } catch {
    return [];
  }
}

export async function loadState(runId: string): Promise<HarnessState> {
  const dir = join(RUNS_DIR, runId);
  const raw = await readFile(join(dir, "state.json"), "utf-8");
  // Parse through the schema so defaults for newer fields (e.g. executorClaims)
  // are applied to runs saved before those fields existed. Fall back to a raw
  // cast if an older run doesn't satisfy the current schema.
  const json = JSON.parse(raw);
  const parsed = HarnessStateSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  // Schema didn't match (unusually shaped old run) — cast, but still guarantee
  // executorClaims exists so downstream `.includes` calls don't throw.
  const state = json as HarnessState;
  if (!Array.isArray(state.executorClaims)) state.executorClaims = [];
  if (!state.claudeSessions || typeof state.claudeSessions !== "object")
    state.claudeSessions = {};
  return state;
}

export async function listRuns(): Promise<string[]> {
  try {
    const entries = await readdir(RUNS_DIR);
    return entries.sort().reverse();
  } catch {
    return [];
  }
}

export type RunSummary = {
  runId: string;
  prompt: string;
  iteration: number;
  maxIterations: number | undefined;
  doneItems: number;
  totalItems: number;
  hasState: boolean;
};

export async function listRunsDetailed(): Promise<RunSummary[]> {
  const runIds = await listRuns();
  const summaries: RunSummary[] = [];
  for (const runId of runIds) {
    const dir = join(RUNS_DIR, runId);
    let prompt = "(no prompt)";
    try {
      prompt = (await readFile(join(dir, "prompt.md"), "utf-8")).trim();
    } catch {
      // ignore — prompt may not exist yet
    }
    const summary: RunSummary = {
      runId,
      prompt: prompt.split("\n")[0].slice(0, 80),
      iteration: 0,
      maxIterations: undefined,
      doneItems: 0,
      totalItems: 0,
      hasState: false,
    };
    try {
      const state = JSON.parse(
        await readFile(join(dir, "state.json"), "utf-8"),
      ) as HarnessState;
      summary.iteration = state.iteration;
      summary.maxIterations = state.maxIterations;
      summary.totalItems = state.checklist.length;
      summary.doneItems = state.checklist.filter(
        (i) => i.status === "done",
      ).length;
      summary.hasState = true;
    } catch {
      // No checkpoint saved (e.g. errored before first checkpoint)
    }
    summaries.push(summary);
  }
  return summaries;
}
