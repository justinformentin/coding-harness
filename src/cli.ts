#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { App } from "./ui/App.js";
import { loadConfig, printConfig } from "./config.js";
import { listRuns } from "./run-store.js";

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
    // A run id is only consumed if the next arg isn't another flag
    const next = args[resumeIdx + 1];
    const runId = next && !next.startsWith("--") ? next : undefined;
    const config = await loadConfig();
    if (runId) {
      render(
        React.createElement(App, { config, resumeRunId: runId })
      );
    } else {
      // No id — let the user pick interactively from recent runs
      render(React.createElement(App, { config, resumePicker: true }));
    }
    return;
  }

  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      `
coding-harness — AI coding agent with external verification

Usage:
  harness              Start interactive session
  harness --config     Show model configuration
  harness --list       List recent runs
  harness --resume ID  Resume a specific run by id
  harness --resume     Pick a recent run to resume interactively
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
