import {
  mkdir,
  writeFile,
  readFile,
  readdir,
  appendFile,
  rename,
  truncate,
} from "fs/promises";
import { join } from "path";
import { createHash, randomUUID } from "crypto";
import { HarnessStateSchema } from "./schemas.js";
import type {
  HarnessState,
  ResolvedConfig,
  VerifierReport,
} from "./schemas.js";
import type { HarnessEvent } from "./harness.js";
import { redactConfig } from "./config.js";
import {
  RunEventSchema,
  type RunEvent,
  type RunEventInput,
} from "./contracts/events.js";
import { replayRunEvents, type RunProjection } from "./contracts/run.js";

const RUNS_DIR = ".runs";

export interface RunStore {
  readonly runId: string;
  append(input: RunEventInput): Promise<RunEvent>;
  readEvents(): Promise<RunEvent[]>;
  replay(): Promise<RunProjection>;
  writeCheckpoint(projection: RunProjection): Promise<void>;
  putArtifact(value: string | Uint8Array): Promise<string>;
  repairPartialTail(): Promise<boolean>;
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, "utf-8");
  await rename(temporary, path);
}

/** A run-scoped writer. Separate stores never share a serialization chain. */
export class FileRunStore {
  readonly directory: string;
  private appendChain: Promise<void> = Promise.resolve();
  private nextSequence: number | undefined;

  constructor(
    readonly runId: string,
    runsDirectory = RUNS_DIR,
  ) {
    this.directory = join(runsDirectory, runId);
  }

  async initialize(): Promise<void> {
    await mkdir(join(this.directory, "artifacts"), { recursive: true });
  }

  append(input: RunEventInput): Promise<RunEvent> {
    let written!: RunEvent;
    const operation = this.appendChain.then(async () => {
      await this.initialize();
      if (this.nextSequence === undefined)
        this.nextSequence = (await this.readEvents()).length;
      written = RunEventSchema.parse({
        schemaVersion: 1,
        eventId: randomUUID(),
        sequence: this.nextSequence,
        timestamp: new Date().toISOString(),
        runId: this.runId,
        ...input,
      });
      await appendFile(
        join(this.directory, "events.jsonl"),
        `${JSON.stringify(written)}\n`,
        "utf-8",
      );
      this.nextSequence++;
    });
    // Keep the queue usable after a caller observes a failed append. Durability
    // errors are deliberately returned, never swallowed.
    this.appendChain = operation.catch(() => {});
    return operation.then(() => written);
  }

  async readEvents(): Promise<RunEvent[]> {
    let raw: string;
    try {
      raw = await readFile(join(this.directory, "events.jsonl"), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const lines = raw.split("\n");
    const events: RunEvent[] = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        const event = RunEventSchema.parse(JSON.parse(line));
        if (event.runId !== this.runId)
          throw new Error(`event belongs to run ${event.runId}`);
        if (event.sequence !== events.length)
          throw new Error(`expected sequence ${events.length}`);
        events.push(event);
      } catch (error) {
        // A crash can leave only the final line incomplete. Corruption in the
        // middle is never hidden because replay would no longer be trustworthy.
        const isFinalNonEmpty = lines
          .slice(index + 1)
          .every((value) => !value.trim());
        if (isFinalNonEmpty && !line.endsWith("}")) break;
        throw new Error(
          `Invalid event at ${this.runId}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return events;
  }

  async replay(): Promise<RunProjection> {
    return replayRunEvents(this.runId, await this.readEvents());
  }

  async writeCheckpoint(projection: RunProjection): Promise<void> {
    await this.initialize();
    await atomicWrite(
      join(this.directory, "checkpoint.json"),
      JSON.stringify(projection, null, 2),
    );
    await atomicWrite(
      join(this.directory, "manifest.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          runId: this.runId,
          status: projection.status,
          updatedAt: new Date().toISOString(),
          lastSequence: projection.lastSequence,
        },
        null,
        2,
      ),
    );
    if (
      [
        "succeeded",
        "failed",
        "cancelled",
        "budget_exhausted",
        "awaiting_review",
      ].includes(projection.status)
    )
      await atomicWrite(
        join(this.directory, "result.json"),
        JSON.stringify(projection, null, 2),
      );
  }

  async putArtifact(value: string | Uint8Array): Promise<string> {
    await this.initialize();
    const bytes =
      typeof value === "string" ? new TextEncoder().encode(value) : value;
    const hash = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(this.directory, "artifacts", hash), bytes, {
      flag: "wx",
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    return hash;
  }

  async repairPartialTail(): Promise<boolean> {
    const path = join(this.directory, "events.jsonl");
    const raw = await readFile(path, "utf-8");
    if (!raw || raw.endsWith("\n")) return false;
    const offset = raw.lastIndexOf("\n") + 1;
    const tail = raw.slice(offset);
    try {
      RunEventSchema.parse(JSON.parse(tail));
      await appendFile(path, "\n", "utf-8");
      return false;
    } catch {
      await truncate(path, Buffer.byteLength(raw.slice(0, offset)));
      this.nextSequence = undefined;
      return true;
    }
  }
}

export async function saveRunInit(
  state: HarnessState,
  config: ResolvedConfig,
): Promise<void> {
  const dir = join(RUNS_DIR, state.runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "request.md"), state.originalPrompt, "utf-8");
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

    lines.push("**Assertions:**");
    for (const assertion of item.assertions)
      lines.push(`- \`${JSON.stringify(assertion)}\``);
    lines.push("");

    lines.push("---", "");
  }

  const planPath = join(dir, "plan.md");
  await writeFile(planPath, lines.join("\n"), "utf-8");
  return planPath;
}

export async function saveChecklist(state: HarnessState): Promise<void> {
  const dir = join(RUNS_DIR, state.runId);
  await writeFile(
    join(dir, "plan.json"),
    JSON.stringify({ schemaVersion: 1, steps: state.checklist }, null, 2),
    "utf-8",
  );
}

export async function saveStateCheckpoint(state: HarnessState): Promise<void> {
  const dir = join(RUNS_DIR, state.runId);
  await atomicWrite(join(dir, "state.json"), JSON.stringify(state, null, 2));
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

const stores = new Map<string, FileRunStore>();

function storeFor(runId: string): FileRunStore {
  let store = stores.get(runId);
  if (!store) {
    store = new FileRunStore(runId);
    stores.set(runId, store);
  }
  return store;
}

export function appendEvent(runId: string, event: HarnessEvent): Promise<void> {
  const { type, ...data } = event;
  return storeFor(runId)
    .append({ type, data })
    .then(() => undefined);
}

export async function loadEvents(runId: string): Promise<HarnessEvent[]> {
  return (await storeFor(runId).readEvents()).map(
    ({ type, data }) => ({ type, ...data }) as HarnessEvent,
  );
}

export async function loadState(runId: string): Promise<HarnessState> {
  const dir = join(RUNS_DIR, runId);
  const raw = await readFile(join(dir, "state.json"), "utf-8");
  const json = JSON.parse(raw);
  return HarnessStateSchema.parse(json);
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
      prompt = (await readFile(join(dir, "request.md"), "utf-8")).trim();
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
        (i) => i.status === "passed",
      ).length;
      summary.hasState = true;
    } catch {
      // No checkpoint saved (e.g. errored before first checkpoint)
    }
    summaries.push(summary);
  }
  return summaries;
}
