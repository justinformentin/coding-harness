# coding-harness

A harness for weak local LLMs that never trusts the model's completion claims. The verifier decides when work is done, not the model.

## Install

```bash
bun install
```

## Run

```bash
# Interactive TUI session
bun run src/cli.ts

# Or after `bun link`:
harness

# Pass a prompt directly
bun run src/cli.ts "implement a fizzbuzz function in TypeScript"
```

## Configure

Create a versioned `.harness.json` at the project root:

```json
{
  "schemaVersion": 1,
  "planner": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514"
  },
  "executor": {
    "provider": "local",
    "model": "qwen2.5-coder:7b",
    "baseUrl": "http://localhost:11434/v1"
  },
  "verifier": {
    "provider": "local",
    "model": "qwen2.5-coder:14b",
    "baseUrl": "http://localhost:11434/v1"
  }
}
```

Configuration is resolved once with this precedence (highest priority last):
built-in defaults, `~/.config/coding-harness/config.json`, project
`.harness.json`, `HARNESS_*` environment variables, and CLI overrides. Layers
are deeply merged and the final result is strictly validated; unknown keys and
invalid environment values are errors rather than silently falling back.

Use `apiKeyEnv` on a model role to name a secret-bearing environment variable.
The value is injected only in memory and is removed from the
`.runs/<id>/config.resolved.json` snapshot.

```bash
harness config validate
harness config show       # redacted values plus field-level provenance
```

Or use environment variables:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export HARNESS_PLANNER_PROVIDER=anthropic
export HARNESS_PLANNER_MODEL=claude-sonnet-4-20250514
export HARNESS_EXECUTOR_PROVIDER=local
export HARNESS_EXECUTOR_MODEL=qwen2.5-coder:7b
export HARNESS_EXECUTOR_BASE_URL=http://localhost:11434/v1
```

## CLI Options

```
harness              Start interactive session
harness --config     Show model configuration
harness config show  Show resolved redacted config and provenance
harness config validate  Validate configuration without starting a run
harness --list       List recent runs
harness --resume ID  Resume a previous run
harness --help       Show this help
```

## Architecture

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

Run state is saved to `.runs/<runId>/` after each iteration for resume support.

For the current architecture audit, comparisons with modern coding-agent
harnesses, and the staged cleanup proposal, see
[`docs/modernization-plan.md`](docs/modernization-plan.md).

## Debug

HARNESS_DEBUG=1 bun run src/cli.ts --claude-code --web
