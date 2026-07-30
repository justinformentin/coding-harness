# Harness modernization plan

**Status:** proposed  
**Scope:** architecture and delivery plan; this document does not authorize a
big-bang rewrite.

## 1. Goal and constraints

This project should make a small local coding model reliable by putting a
deterministic controller around it. The controller, rather than the model,
owns transitions, budgets, persistence, and the definition of done. The model
may propose actions and evidence, but it cannot mark its own work verified.

The design should remain small enough to understand without a framework. It
should also support:

- bounded, recoverable execution instead of an accidentally infinite loop;
- one canonical configuration with explicit precedence and a redacted snapshot;
- an append-only run record from which current state can be reconstructed;
- typed events that power both terminal and web clients;
- deterministic verification where possible and isolated model judgment where
  unavoidable;
- enough telemetry and replay support to improve prompts and compare small
  models empirically.

## 2. Investigation

This proposal draws on the public implementations and documentation below. The
useful lesson is not to copy a large product; it is to preserve the small,
composable control-plane ideas that make those products debuggable.

### OpenCode

OpenCode separates the long-lived server/session domain from its clients,
represents activity as events, persists messages and message parts, and places
provider/model behavior behind adapters. Its configuration is layered, and its
agent, command, permission, tool, and provider settings are declarative rather
than embedded in a single loop.

Relevant upstream material:

- [OpenCode repository](https://github.com/anomalyco/opencode)
- [OpenCode configuration documentation](https://opencode.ai/docs/config/)
- [OpenCode agents documentation](https://opencode.ai/docs/agents/)
- [OpenCode server documentation](https://opencode.ai/docs/server/)

**Takeaways for this harness:** keep the core independent of Ink/web, use a
single typed event protocol, give every message/tool operation a stable ID, and
resolve configuration once before starting a run. Do not import OpenCode's
product breadth, client SDK, or permission surface until this harness needs it.

### Pi (`pi-mono`)

Pi's coding agent favors a deliberately small core with an explicit agent loop,
JSONL sessions, context compaction, interchangeable model providers, and an
extension system around tools and lifecycle events. Its session format is a
tree rather than only a flat chat transcript, which permits branching without
rewriting history.

Relevant upstream material:

- [`pi-mono` repository](https://github.com/badlogic/pi-mono)
- [`pi-agent-core` package](https://github.com/badlogic/pi-mono/tree/main/packages/agent)
- [`pi-coding-agent` package and session docs](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)

**Takeaways for this harness:** keep the turn loop simple, make append-only JSONL
the source of truth, make compaction an explicit persisted event, and expose
small lifecycle hooks rather than hard-coding every integration. Branching is
useful later, but is not required for the first cleanup.

### General harness engineering

Anthropic distinguishes predictable workflows from autonomous agents and
recommends starting with the simplest composable pattern. Its evaluator-
optimizer pattern maps closely to this project's execute/verify/repair intent.
OpenAI's Agents SDK treats runs as traces made of spans, with handoffs, model
calls, and tool calls observable as separate operations. Both approaches make
the control loop and evidence visible instead of hiding them in prompt text.

- [Anthropic: Building effective agents](https://www.anthropic.com/research/building-effective-agents)
- [OpenAI Agents SDK: tracing](https://openai.github.io/openai-agents-js/guides/tracing/)
- [OpenAI Agents SDK: running agents](https://openai.github.io/openai-agents-js/guides/running-agents/)

**Takeaways for this harness:** prefer workflow steps until autonomy is needed,
trace every expensive or state-changing operation, impose budgets and stop
reasons, and evaluate the harness with fixed tasks rather than judging it from
one interactive demo.

## 3. Current-state findings

The repository already has a credible prototype: a planner creates typed
checklist items, the executor uses allowlisted tools, verification is
deterministic-first, runs have JSONL logs and checkpoints, resume exists, and
the TUI/web interfaces consume loop events. These are worth retaining.

The cleanup should address the following gaps.

### Loop semantics

- The unit called an `iteration` can execute every outstanding checklist item,
  then verify the entire plan. This makes retry counts and traces ambiguous.
- Unbounded execution is the default. There is no wall-clock, token, cost,
  repeated-failure, or no-progress budget.
- Checklist dependencies are planned but not enforced by the scheduler.
- There is no explicit run/step state machine. Status is inferred from mutable
  fields and emitted UI events, so invalid transitions are possible.
- Resume resets the iteration counter and can therefore obscure the actual
  attempt history.
- Repair feedback is appended to an ever-growing conversation. There is no
  context budget, summary/compaction policy, or clean per-step context view.

### Verification

- Required command checks use substring matching, so one command can
  accidentally satisfy another. Success indicators are detached from the
  command that was supposed to produce them.
- Required patterns are searched across any changed file or any output rather
  than a declared path/command. Forbidden patterns only inspect tracked changed
  files. Invalid regular expressions can crash verification.
- File-change evidence trusts model/tool bookkeeping rather than a before/after
  workspace snapshot or version-control diff.
- Previously completed items are never revalidated, even if later work breaks
  them. Dependencies and regression checks therefore have no effect.
- `manual` currently means an executor completion claim is enough. That is a
  useful `attempted` signal, not verification, and should be labeled as such.

### Configuration and safety

- Configuration is one model object plus a few ad-hoc options. There is no
  version, project root, policy, budget, loop, persistence, compaction, or trace
  section.
- Invalid config falls back to defaults instead of failing with field-level
  diagnostics. Environment provider values are cast without validation.
- API keys can be serialized into a run's `config.json`.
- Tool paths and shell working directories need one canonical workspace policy,
  normalized traversal checks, output limits, and configurable timeouts.
- The Claude Code convenience override enables bypassed permissions by default.

### Run files and traces

- `state.json`, several specialized JSONL files, and `events.jsonl` overlap but
  have no schema version or migration contract.
- Append failures are intentionally swallowed; a run can look durable when its
  trace is incomplete. Checkpoint writes are not atomic.
- The global append promise serializes all runs and is not scoped to a run
  store instance.
- Events do not consistently carry event IDs, parent span IDs, attempt IDs,
  duration, model usage, stop reason, or error structure. Streaming tokens are
  omitted, but no final canonical model response event replaces all of their
  diagnostic value.
- There is no replay/repair command, trace exporter, retention policy, or
  machine-readable final result.

### Maintainability and evaluation

- The loop coordinates scheduling, model calls, persistence, tracing, UI
  projection, and cancellation in one module.
- Core behavior has no automated test script or committed fixtures.
- There is no benchmark set for measuring completion rate, false-positive
  verification, iterations, latency, or model/tool usage.
- The design document describes an earlier, simpler implementation and is
  already inconsistent with the current code.

## 4. Target design

Keep a single-process architecture, but establish four boundaries:

```text
CLI / TUI / web
      | commands                         | event subscription
      v                                  v
Run controller -> scheduler -> executor -> verifier
      |               |          |           |
      +---------------+----------+-----------+
                      |
              RunStore + TraceSink
                      |
                 Workspace/Tools
```

### Controller state machine

Use explicit run and step statuses. Only the controller can transition them.

```text
run:  created -> planning -> awaiting_approval -> running
      -> succeeded | failed | cancelled | budget_exhausted

step: pending -> ready -> executing -> verifying
      -> passed | retryable | blocked | failed | skipped
```

Each scheduler pass selects one `ready` step whose dependencies have passed.
One attempt means one execution followed by verification for one step. After a
step passes, run affected regression checks before selecting the next step.
This produces clear retry accounting and keeps weak-model context focused.

The controller stops on one of a closed set of reasons: `completed`,
`cancelled`, `max_attempts`, `max_model_calls`, `max_tool_calls`, `deadline`,
`no_progress`, `blocked`, or `fatal_error`. Default budgets must be finite; a
user may opt into unlimited values explicitly.

### Plan and verification contract

Replace loose verifier arrays with typed assertions:

```json
{
  "id": "tests-pass",
  "description": "Run the unit suite",
  "dependsOn": ["implement-change"],
  "verify": [
    { "kind": "command", "argv": ["bun", "test"], "exitCode": 0 },
    { "kind": "stdout", "from": "assertion:0", "contains": "pass" }
  ]
}
```

Initial assertion kinds should be `file_exists`, `file_matches`,
`file_not_matches`, `command`, `stdout`, `git_diff`, and `human_review`.
Assertions name their evidence source and produce a structured result with
expected, actual, and artifact references. Shell commands should prefer argv
over command strings. A semantic `model_judge` remains available but cannot be
used to satisfy deterministic assertions.

Planning gets its own validation pass before approval: unique IDs, acyclic and
known dependencies, supported assertions, workspace-relative paths, at least
one assertion per implementation step, and commands allowed by policy.

### Versioned resolved configuration

Adopt one schema and print the provenance of every resolved field:

```json
{
  "schemaVersion": 1,
  "models": { "planner": {}, "executor": {}, "verifier": {} },
  "loop": {
    "maxAttemptsPerStep": 3,
    "maxModelCalls": 40,
    "maxToolCalls": 100,
    "deadlineSeconds": 3600,
    "noProgressAttempts": 2
  },
  "workspace": {
    "root": ".",
    "allowWrite": ["**"],
    "denyWrite": [".git/**", ".runs/**"],
    "commandTimeoutSeconds": 120,
    "maxOutputBytes": 100000
  },
  "context": { "maxMessages": 40, "maxBytes": 200000 },
  "runs": { "directory": ".runs", "checkpointEveryEvents": 25 },
  "tracing": { "enabled": true, "captureModelText": true }
}
```

Precedence should be documented and testable:

```text
built-in defaults < user config < project config < environment < CLI
```

Parse and merge plain input first, validate exactly once afterward, reject
unknown/invalid values, and write a redacted `config.resolved.json`. Secrets
must be referenced by environment-variable name and never persisted.

### Canonical run directory

Make `events.jsonl` the canonical append-only record and treat other files as
projections or immutable inputs:

```text
.runs/<run-id>/
  manifest.json           # schema version, timestamps, status, stop reason
  request.md              # immutable user request
  config.resolved.json    # immutable and redacted
  plan.json               # accepted plan, versioned
  events.jsonl            # source of truth, monotonically sequenced
  checkpoint.json         # atomic disposable projection for fast resume
  artifacts/              # large outputs/diffs addressed by content hash
  result.json             # final machine-readable outcome
```

Every event should contain `schemaVersion`, `eventId`, `sequence`, `timestamp`,
`runId`, `type`, and `data`; operation events also contain `spanId`,
`parentSpanId`, `stepId`, and `attempt`. Model-call end events record provider,
model, duration, usage when available, stop reason, and response artifact.
Tool-call end events record normalized input, duration, exit/result status, and
bounded output artifact. Secret-bearing fields are redacted at the sink.

Use a per-run writer, fsync at meaningful boundaries, and atomic
write-then-rename checkpoints. On resume, validate the event stream, discard a
partial final line, replay it, reconcile any in-flight operation as
`interrupted`, and continue without resetting counters.

### Context and progress control

Build each executor request from the immutable task, the current step, relevant
workspace observations, the previous attempt result, and verifier feedback—not
the entire historic chat by default. Persist summaries as `context_compacted`
events and retain links to original artifacts.

Compute a progress fingerprint after each attempt from the workspace diff,
assertion results, and completed step IDs. Repeating the same fingerprint with
the same failures consumes the no-progress budget and then stops as
`no_progress`; it must not prompt forever.

## 5. Delivery plan

Each phase should be a reviewable pull request and leave the harness runnable.

### Phase 0 — Characterize current behavior

1. Add a test runner and fixtures for config precedence, plan parsing, tool-call
   parsing, deterministic checks, event persistence, cancellation, and resume.
2. Add three end-to-end fake-provider scenarios: success, repair-then-success,
   and budget exhaustion. No network or real model should be required.
3. Capture the current run layout as a legacy fixture.

**Exit gate:** `bun test` and `bun run typecheck` pass; the fixtures demonstrate
current resume and completion behavior.

### Phase 1 — Contracts and configuration

1. Introduce versioned `ResolvedConfig`, `Plan`, `Assertion`, `RunEvent`, and
   `RunResult` schemas in modules grouped by domain rather than one schema file.
2. Implement explicit layered config loading with provenance, strict errors,
   secret redaction, `harness config show`, and `harness config validate`.
3. Add legacy config translation with warnings for one compatibility window.
4. Validate plan dependencies and assertions before plan approval.

**Exit gate:** malformed config and plans fail before a model/tool call; no
fixture serializes credentials.

### Phase 2 — Run store and trace protocol

1. Add a `RunStore` interface and filesystem implementation with a per-run
   serialized writer, event sequence checks, artifact hashes, and atomic
   checkpoints.
2. Emit the canonical event envelope and derive checkpoint/result state through
   a pure reducer.
3. Add migration/replay for legacy runs and commands: `harness run inspect ID`,
   `harness run events ID`, and `harness run repair ID`.
4. Adapt TUI and web UI to the same reducer/event subscription rather than
   maintaining implicit interpretations.

**Exit gate:** deleting a checkpoint and replaying events reproduces the same
state; truncating the last JSONL line is recoverable; two concurrent run stores
do not interfere.

### Phase 3 — Deterministic step loop

1. Extract `RunController`, dependency-aware `Scheduler`, `Executor`, and
   `Verifier` interfaces from the existing harness module.
2. Execute and verify one step attempt at a time with explicit transitions.
3. Enforce finite budgets, cancellation, deadlines, and no-progress detection;
   persist counters and stop reasons so resume cannot reset them.
4. Replace loose verification fields with source-bound assertions, safe regex
   compilation, exact argv/exit checks, and workspace-diff evidence.
5. Re-run impacted verification after later edits and distinguish
   `human_review` from `passed` in the final result.

**Exit gate:** every loop termination maps to a tested stop reason; a model
claim alone cannot pass an assertion; repeated identical failures stop.

### Phase 4 — Model and context reliability

1. Normalize provider results into text, structured tool calls, usage, and stop
   reason. Keep free-form tool blocks only as a compatibility adapter.
2. Add bounded parse/repair for structured planner and verifier output; record
   every failed parse as evidence rather than silently extracting broad JSON.
3. Build per-step context views and explicit compaction with artifact links.
4. Add retry policy by error class with jitter for transient provider failures;
   never retry policy errors or deterministic assertion failures blindly.
5. Make optional model-judge decisions include a rubric and evidence IDs, and
   surface them as lower-confidence than deterministic passes.

**Exit gate:** provider contract tests pass; context stays within configured
limits; all model/tool calls have matching trace spans.

### Phase 5 — Evaluation and extension seams

1. Add a checked-in task corpus covering file edits, tests, debugging,
   multi-step dependencies, impossible requests, and verifier-adversarial
   completion claims.
2. Produce a JSON/Markdown evaluation report with completion rate,
   deterministic false-pass rate, attempts, model/tool calls, duration, and
   usage. Pin prompts/config hashes for comparisons.
3. Add typed lifecycle hooks (`before_model`, `after_model`, `before_tool`,
   `after_tool`, `on_event`) after the core contracts stabilize. Hooks may
   observe or veto through explicit return values, never mutate state directly.
4. Add an optional OpenTelemetry exporter while retaining local JSONL as the
   zero-dependency default.

**Exit gate:** two model/config combinations can be compared reproducibly, and
extensions cannot bypass workspace policy or fabricate verifier evidence.

## 6. Explicit non-goals for the cleanup

- A distributed job queue or database.
- Multi-agent delegation, branching sessions, or speculative parallel edits.
- A general plugin marketplace.
- Automatic telemetry upload.
- Supporting every provider-specific feature in the core domain model.
- Replacing deterministic tests with an LLM judge.

These can be reconsidered after replay, budgets, verification, and evaluation
are dependable. Adding them earlier would increase surface area without making
small local models more reliable.

## 7. Decisions to record before implementation

Create short architecture decision records for:

1. JSONL events as the source of truth and checkpoint snapshots as projections.
2. One-step attempts rather than whole-plan iterations.
3. Finite default budgets and the exact shipped values.
4. The shell policy: argv-only by default versus an explicitly enabled shell.
5. Whether `human_review` prevents a run from being called `succeeded` or
   produces a distinct `awaiting_review` terminal state.
6. The legacy run/config compatibility window.

The first implementation PR should be Phase 0, not a controller rewrite. Tests
and replay fixtures provide the safety net needed to simplify the prototype
without losing the behavior that already works.
