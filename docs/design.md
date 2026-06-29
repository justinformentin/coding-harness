# Coding Harness — Design Spec

> A harness for weak local LLMs that never trusts the model's completion claims. The verifier decides when work is done, not the model.

## Core Principle

The local model can do the work. The verifier decides whether the work is done. The model can say "complete", "done", or "finalized" — the harness treats that as a request for verification, not proof of completion.

```
Model says: complete
Harness says: needs_verification
Verifier checks evidence
Only verifier can say: done = true
```

## Stack

- **Runtime:** Bun
- **Language:** TypeScript
- **Schema validation:** Zod (only non-trivial dependency)
- **LLM client:** Custom fetch-based HTTP client (no SDK)
- **TUI:** ink (React for the terminal)
- **Providers:** OpenAI, Anthropic (cloud, for planning), any OpenAI-compatible local server (for execution/verification)

## Architecture

Flat pipeline with a shared mutable state object. No framework, no graph library. A while loop with an if statement.

```
User types prompt
  ↓
planner(prompt) → checklist
  ↓
while (iteration < maxIterations):
  executor(state) → tool calls
  runTools(toolCalls, state) → artifacts
  verifier(state) → VerifierReport
  if report.done → break
  repairPrompt(report, state) → retry prompt
  iteration++
  ↓
finalize(state) → summary, save run
```

## Project Structure

```
coding-harness/
  src/
    cli.ts              # Entry point, ink app setup, run management
    harness.ts          # The main loop: plan → execute → verify → repeat
    state.ts            # HarnessState type + helpers
    llm.ts              # Minimal OpenAI-compatible + Anthropic HTTP client
    planner.ts          # Converts user prompt → checklist via cloud model
    executor.ts         # Drives the local model through checklist items
    verifier.ts         # Deterministic checks + optional LLM judge
    tools.ts            # Tool registry and execution (allowlisted)
    tools/
      files.ts          # read_file, write_file, edit_file, list_files
      shell.ts          # run_command (with timeout + output capture)
      search.ts         # grep, git_diff
    schemas.ts          # Zod schemas for checklist, verifier report, etc.
    run-store.ts        # Save/load runs to .runs/ directory
    prompts.ts          # All LLM prompt templates in one place
    ui/
      App.tsx           # Root ink component
      Header.tsx        # Title + iteration counter
      Checklist.tsx     # Checklist with status icons
      Log.tsx           # Scrolling output log
      Input.tsx         # Prompt input
  package.json
  tsconfig.json
```

## Core State

One mutable object threaded through every function:

```typescript
type ChecklistItem = {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "done" | "failed";
  acceptanceCriteria: string[];
  evidenceRequired: string[];
  evidenceFound: string[];
};

type HarnessState = {
  originalPrompt: string;
  checklist: ChecklistItem[];
  messages: Message[];
  artifacts: {
    filesChanged: string[];
    commandsRun: string[];
    commandOutputs: string[];
  };
  verifierReport?: VerifierReport;
  iteration: number;
  maxIterations: number;
  runId: string;
  startedAt: number;
};
```

Messages use roles `"user" | "assistant" | "tool"`. The executor maintains a running conversation. Planner and verifier conversations are ephemeral.

## LLM Client

Three provider types, one interface:

```typescript
type Provider = "openai" | "anthropic" | "local";

type ModelConfig = {
  planner:  { provider: Provider; model: string; baseUrl?: string; apiKey?: string };
  executor: { provider: Provider; model: string; baseUrl?: string; apiKey?: string };
  verifier: { provider: Provider; model: string; baseUrl?: string; apiKey?: string };
};
```

Two HTTP paths under the hood:
1. **OpenAI-compatible** — covers OpenAI and local models (both `/v1/chat/completions`). Difference is baseUrl and apiKey.
2. **Anthropic** — different API shape (`/v1/messages`, system as top-level field). Separate fetch function, same return type.

Both return `string`. Caller parses JSON when structured output is expected.

```typescript
async function chat(config: RoleModelConfig, messages: Message[]): Promise<string>
```

Dispatches to the right HTTP implementation based on `config.provider`.

Default config via `.harness.json` or env vars. API keys from `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`. No keys needed for local.

No streaming for v1. No retry logic. Errors propagate and the run saves state for resume.

## Tools

Allowlisted tools only. The executor emits JSON tool calls, the harness parses and runs them.

### File tools
- `read_file(path)` — returns file contents
- `write_file(path, content)` — creates or overwrites
- `edit_file(path, old, new)` — find-and-replace within a file
- `list_files(path, pattern?)` — glob-based directory listing

### Shell tools
- `run_command(command, cwd?)` — shell command with stdout/stderr capture, 30s timeout, scoped to project root

### Search tools
- `grep(pattern, path?, include?)` — regex search across files
- `git_diff()` — returns current diff

Tool results auto-append to `state.artifacts`. Tool definitions serialized into the executor's system prompt.

```typescript
type Tool = {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  execute: (args: Record<string, unknown>) => Promise<string>;
};
```

## Verifier

The core of the product. Only authority that can end the loop.

### Verification Hierarchy (checked in order)

**Layer 1 — Deterministic checks (no model):**
- Required files exist
- Required commands were actually run
- Forbidden patterns absent (TODO, placeholder, FIXME)
- Expected patterns present in file contents or diffs

**Layer 2 — Artifact checks:**
- git diff output matches expected scope
- Command outputs contain success indicators
- All checklist items' evidenceRequired satisfied by evidenceFound

**Layer 3 — LLM judge (only when deterministic checks aren't conclusive):**
- Send checklist + artifacts + executor's claim to verifier model
- Ask: "Based on the evidence, which items are actually complete?"
- Parse structured JSON response

### Verifier Config (per checklist item, generated by planner)

```typescript
type VerifierConfig = {
  requiredCommands?: string[];
  requiredFiles?: string[];
  requiredPatterns?: string[];
  forbiddenPatterns?: string[];
  successIndicators?: string[];
};
```

### Verifier Output

```typescript
type VerifierReport = {
  done: boolean;
  completedItems: string[];
  incompleteItems: string[];
  missingEvidence: string[];
  nextInstruction: string;
};
```

### Completion-Claim Interception

If the executor says "complete"/"done"/"finalized", the harness logs it but does not treat it as authoritative. Deterministic layers run first and can overrule it. The model's claim is one data point the LLM judge can consider.

## Run Persistence

```
.runs/
  <runId>/
    prompt.md
    config.json
    checklist.json
    state.json            # overwritten each iteration (resume checkpoint)
    iterations.jsonl      # append-only, one JSON line per iteration
    verifier-reports.jsonl
    commands.jsonl
```

## TUI (ink)

Four components:
1. **Header** — title + iteration counter
2. **Checklist** — status icons (✓ done, ⠋ in_progress, ○ pending, ✗ failed)
3. **Log** — scrolling output from executor, tools, verifier
4. **Input** — prompt input at bottom

## CLI

- `harness` — start interactive session
- `harness --resume <runId>` — resume a saved run
- `harness --list` — show recent runs
- `harness --config` — print model config

## Dependencies (total)

- `zod` — schema validation
- `ink` + `react` — TUI
- That's it.
