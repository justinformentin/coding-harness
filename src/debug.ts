import { appendFileSync } from "fs";
import { join } from "path";

// ─────────────────────────────────────────────────────────────────────────────
// File-based debug tracing
//
// The harness runs inside an Ink TUI, which owns stdout/stderr — writing debug
// output with console.* corrupts the rendered display. Instead we append
// timestamped lines to a file the user can watch in a second terminal:
//
//     HARNESS_DEBUG=1 bun run src/cli.ts "your prompt"
//     tail -f harness-debug.log        # in another terminal
//
// Enabled whenever HARNESS_DEBUG is set to anything other than "0"/"false".
// The target file defaults to ./harness-debug.log and can be overridden with
// HARNESS_DEBUG_LOG. When disabled, debug()/time() are near-zero-cost no-ops.
// ─────────────────────────────────────────────────────────────────────────────

const raw = process.env.HARNESS_DEBUG;
export const debugEnabled =
  raw !== undefined && raw !== "" && raw !== "0" && raw !== "false";

const logPath =
  process.env.HARNESS_DEBUG_LOG ?? join(process.cwd(), "harness-debug.log");

// High-resolution monotonic clock so we can measure durations without tripping
// the sandbox's Date.now() restrictions and to see exactly where time goes.
function stamp(): string {
  const ms = performance.now();
  return `+${(ms / 1000).toFixed(3)}s`;
}

/**
 * Append one DEBUG line to the log file. `scope` names the stage (e.g.
 * "planner", "llm", "executor"); `detail` is optional structured context that
 * gets JSON-stringified. Silent no-op when HARNESS_DEBUG is unset.
 */
export function debug(scope: string, message: string, detail?: unknown): void {
  if (!debugEnabled) return;
  let line = `${stamp()} DEBUG: [${scope}] ${message}`;
  if (detail !== undefined) {
    let rendered: string;
    try {
      rendered = typeof detail === "string" ? detail : JSON.stringify(detail);
    } catch {
      rendered = String(detail);
    }
    if (rendered.length > 500) rendered = rendered.slice(0, 500) + "…";
    line += ` ${rendered}`;
  }
  try {
    appendFileSync(logPath, line + "\n");
  } catch {
    // Never let logging break the run.
  }
}

/**
 * Wrap an async operation to log its start and end (with elapsed ms). Useful for
 * pinpointing which stage hangs — the "start" line appears with no matching
 * "done" line for whatever is stuck.
 */
export async function time<T>(
  scope: string,
  message: string,
  fn: () => Promise<T>
): Promise<T> {
  if (!debugEnabled) return fn();
  const start = performance.now();
  debug(scope, `${message} — start`);
  try {
    const result = await fn();
    debug(scope, `${message} — done in ${Math.round(performance.now() - start)}ms`);
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    debug(scope, `${message} — FAILED after ${Math.round(performance.now() - start)}ms: ${msg}`);
    throw e;
  }
}

// Emitted once at startup so the user knows the log is live and where it lives.
export function announceDebug(): void {
  if (!debugEnabled) return;
  debug("harness", `=== debug tracing started (pid ${process.pid}) → ${logPath} ===`);
}
