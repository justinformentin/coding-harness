#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { App } from "./ui/App.js";
import { loadConfig, printConfig, applyClaudeCodeOverride } from "./config.js";
import { listRuns } from "./run-store.js";

// Read an explicit iteration cap from --max-iterations / --iterations, if any.
// Returns undefined when the flag is absent or its value isn't a positive
// number, leaving the loop unbounded.
function parseMaxIterationsFlag(args: string[]): number | undefined {
  const idx = args.findIndex(
    (a) => a === "--max-iterations" || a === "--iterations"
  );
  if (idx === -1) return undefined;
  const v = Number(args[idx + 1]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

async function main() {
  const args = process.argv.slice(2);

  // Handle flags
  if (args.includes("--web")) {
    const { startServer } = await import("../packages/web/server/index.js");
    await startServer(3131);
    const { exec } = await import("child_process");
    const openCmd =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
        ? "start"
        : "xdg-open";
    exec(`${openCmd} http://localhost:3131`);
    console.log("Harness web UI running at http://localhost:3131");
    return;
  }

  if (args.includes("--config")) {
    const config = await loadConfig();
    console.log(printConfig(config));
    process.exit(0);
  }

  if (args.includes("--list")) {
    const runs = await listRuns();
    if (runs.length === 0) {
      console.log("No runs found.");
    } else {
      console.log("Recent runs:");
      for (const run of runs.slice(0, 20)) {
        console.log(`  ${run}`);
      }
    }
    process.exit(0);
  }

  const resumeIdx = args.indexOf("--resume");
  if (resumeIdx !== -1) {
    // A run id is only consumed if the next arg isn't another flag
    const next = args[resumeIdx + 1];
    const runId = next && !next.startsWith("--") ? next : undefined;
    const config = await loadConfig();
    // Flag overrides any cap from .harness.json / env; absent both, undefined
    // (unbounded) — a resumed run is no longer pinned to its saved cap.
    const maxIterations = parseMaxIterationsFlag(args) ?? config.maxIterations;
    // Honor --claude-code (and its --model) on resume too. Without this, the
    // resume branch returned before the override below ever ran, so resumed
    // runs silently fell back to the local executor model.
    if (args.includes("--claude-code")) {
      const modelIdx = args.indexOf("--model");
      const ccModel =
        modelIdx !== -1 && args[modelIdx + 1] ? args[modelIdx + 1] : undefined;
      applyClaudeCodeOverride(config, ccModel);
    }
    if (runId) {
      render(
        React.createElement(App, { config, resumeRunId: runId, maxIterations })
      );
    } else {
      // No id — let the user pick interactively from recent runs
      render(
        React.createElement(App, { config, resumePicker: true, maxIterations })
      );
    }
    return;
  }

  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      `
coding-harness — AI coding agent with external verification

Usage:
  harness                    Start interactive session
  harness --config           Show model configuration
  harness --list             List recent runs
  harness --resume ID        Resume a specific run by id
  harness --resume           Pick a recent run to resume interactively
  harness --claude-code      Use the local Claude Code CLI for all roles
                             (reuses your Claude Code login — no API key)
  harness --model NAME       Model for --claude-code (default: sonnet)

  To use Claude Code for just one role, set "provider": "claude-code" on
  that role in .harness.json (options: anthropic | claude-code | local).
  harness --web              Start the web UI at http://localhost:3131
  harness --max-iterations N Cap the execute/verify loop at N iterations.
                             No cap by default — the loop runs until the
                             verifier reports done. Can also be set via
                             HARNESS_MAX_ITERATIONS or "maxIterations" in
                             .harness.json (the flag overrides both).
  harness --help             Show this help
    `.trim()
    );
    process.exit(0);
  }

  // Flags that consume the following token as their value.
  const FLAGS_WITH_VALUE = new Set([
    "--model",
    "--max-iterations",
    "--iterations",
  ]);

  // Collect positional (non-flag) args as the prompt, skipping flag values.
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (FLAGS_WITH_VALUE.has(a)) i++;
      continue;
    }
    positional.push(a);
  }
  const promptArg = positional.join(" ").trim();

  const config = await loadConfig();

  // Optional iteration cap. Flag wins over .harness.json / env; absent all
  // three, undefined → the loop runs unbounded until the verifier is done.
  const maxIterations = parseMaxIterationsFlag(args) ?? config.maxIterations;

  // --claude-code overrides all roles to the local `claude` CLI.
  if (args.includes("--claude-code")) {
    const modelIdx = args.indexOf("--model");
    const ccModel =
      modelIdx !== -1 && args[modelIdx + 1] ? args[modelIdx + 1] : undefined;
    applyClaudeCodeOverride(config, ccModel);
  }

  render(
    React.createElement(App, {
      config,
      initialPrompt: promptArg || undefined,
      maxIterations,
    })
  );
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(msg);
  process.exit(1);
});
