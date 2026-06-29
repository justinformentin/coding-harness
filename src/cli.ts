#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { App } from "./ui/App.js";
import { loadConfig, printConfig } from "./config.js";
import { listRuns, loadState } from "./run-store.js";

async function main() {
  const args = process.argv.slice(2);

  // Handle flags
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
    const runId = args[resumeIdx + 1];
    if (!runId) {
      console.error("Usage: harness --resume <runId>");
      process.exit(1);
    }
    try {
      const state = await loadState(runId);
      console.log(
        `Resuming run ${runId} (iteration ${state.iteration}/${state.maxIterations})`
      );
      // TODO: implement full resume through TUI
      process.exit(0);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Could not load run ${runId}: ${msg}`);
      process.exit(1);
    }
  }

  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      `
coding-harness — AI coding agent with external verification

Usage:
  harness              Start interactive session
  harness --config     Show model configuration
  harness --list       List recent runs
  harness --resume ID  Resume a previous run
  harness --help       Show this help
    `.trim()
    );
    process.exit(0);
  }

  // Start interactive session — check if a prompt was passed as argument
  const promptArg = args.filter((a) => !a.startsWith("--")).join(" ").trim();

  const config = await loadConfig();
  render(
    React.createElement(App, {
      config,
      initialPrompt: promptArg || undefined,
    })
  );
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(msg);
  process.exit(1);
});
