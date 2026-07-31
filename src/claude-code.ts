import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { debug } from "./debug.js";

// ─────────────────────────────────────────────────────────────────────────────
// Orphan-process cleanup
//
// Every `claude` subprocess we spawn is registered here so we can tear them
// down when the harness exits. Without this, closing the harness abruptly —
// terminal window closed (SIGHUP), an external `kill` (SIGTERM), or a crash —
// would orphan the sub-`claude` processes, which keep running (and burning
// tokens) with no parent. The registry + signal handlers below guarantee they
// are killed with us. (A hard `kill -9` of the harness itself is unrecoverable
// and will still orphan children — nothing in-process can prevent that.)
// ─────────────────────────────────────────────────────────────────────────────

const liveChildren = new Set<ChildProcess>();
let cleanupInstalled = false;

function killAllChildren(signal: NodeJS.Signals) {
  for (const child of liveChildren) {
    try {
      child.kill(signal);
    } catch {
      // Already exited — nothing to do.
    }
  }
}

// Register process-level teardown once, lazily on the first spawn.
function installProcessCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;

  // Synchronous backstop. Covers a normal exit and ink's Ctrl+C handling: in
  // raw mode Ctrl+C is delivered to us as input (ink unmounts and lets the
  // process exit) rather than as a SIGINT signal, so the "exit" event is what
  // actually catches an interactive quit. child.kill() is synchronous, so this
  // is safe to run here.
  process.on("exit", () => killAllChildren("SIGKILL"));

  // External termination: ask children to stop, escalate to SIGKILL after a
  // grace period, then exit ourselves so the signal isn't swallowed.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      debug(
        "claude-code",
        `received ${sig} — killing ${liveChildren.size} child process(es)`,
      );
      killAllChildren("SIGTERM");
      const t = setTimeout(() => {
        killAllChildren("SIGKILL");
        process.exit(sig === "SIGINT" ? 130 : 143);
      }, 2000);
      t.unref?.();
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude Code provider
//
// Instead of calling an LLM API directly, this provider shells out to the local
// `claude` CLI in headless print mode (`claude -p`). This lets the harness reuse
// whatever authentication the user already has set up for Claude Code — including
// a Claude Pro/Max subscription login — without the harness ever handling an API
// key or OAuth token itself. The CLI does the inference under its own terms.
//
// We use `--output-format stream-json --verbose` so we can observe assistant
// text, tool uses, and the final result event as they happen.
// ─────────────────────────────────────────────────────────────────────────────

export type ClaudeCodeToolUse = { name: string; input: unknown };

export type RunClaudeCodeOptions = {
  /** The user prompt (sent via stdin to avoid arg-length limits). */
  prompt: string;
  /** Appended to Claude Code's system prompt. */
  systemPrompt?: string;
  /** Model alias or id, e.g. "sonnet", "opus", "claude-sonnet-4-6". */
  model?: string;
  /** Working directory for the spawned process. */
  cwd?: string;
  /** Allowlist of tools (omit for Claude Code's defaults). */
  allowedTools?: string[];
  /** Tools that must never be used (e.g. ["Write","Edit"] for read-only roles). */
  disallowedTools?: string[];
  /** Run non-interactively without permission prompts. Required for autonomy. */
  dangerouslySkipPermissions?: boolean;
  /**
   * Isolate the spawned CLI from the user's global config. When true (the
   * default) we pass --strict-mcp-config (load no inherited MCP servers) and
   * restrict --setting-sources, so slow/auth-gated MCP connections and
   * user-level SessionStart hooks don't run on every spawn. Set false to
   * inherit the user's full environment.
   */
  isolateConfig?: boolean;
  /** Setting sources to load when isolating (default: ["project","local"]). */
  settingSources?: Array<"user" | "project" | "local">;
  /**
   * Resume a prior sub-Claude session by id (passed as `claude --resume <id>`).
   * Lets an interrupted item continue its own conversation instead of
   * cold-starting a fresh session. The session id is reported back on
   * RunClaudeCodeResult.sessionId.
   */
  resumeSessionId?: string;
  signal?: AbortSignal;
  /** Fires for each chunk of assistant-visible text as it streams. */
  onToken?: (token: string) => void;
  /** Fires for each tool the model invokes. */
  onToolUse?: (use: ClaudeCodeToolUse) => void;
};

export type RunClaudeCodeResult = {
  /** The final result text from the `result` event. */
  text: string;
  /** Every tool the model used during the run. */
  toolUses: ClaudeCodeToolUse[];
  numTurns: number;
  /** The CLI session id, if reported — used to `--resume` this run later. */
  sessionId?: string;
};

type StreamEvent = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  num_turns?: number;
  session_id?: string;
  result?: unknown;
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      name?: string;
      input?: unknown;
    }>;
  };
};

export async function runClaudeCode(
  opts: RunClaudeCodeOptions,
): Promise<RunClaudeCodeResult> {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  if (opts.model) args.push("--model", opts.model);
  if (opts.systemPrompt) args.push("--append-system-prompt", opts.systemPrompt);
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push("--allowedTools", opts.allowedTools.join(","));
  }
  if (opts.disallowedTools && opts.disallowedTools.length > 0) {
    args.push("--disallowedTools", opts.disallowedTools.join(","));
  }
  if (opts.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  // Isolate from the user's global config unless explicitly told not to. This
  // is the fix for slow/hanging spawns: without it, every sub-`claude` boots
  // all the user's MCP servers (Figma, Slack, codebase-memory, …) and runs
  // their user-level SessionStart hook, which can take many seconds or stall on
  // an auth-gated connector before the model ever starts working.
  if (opts.isolateConfig !== false) {
    args.push("--strict-mcp-config");
    const sources = opts.settingSources ?? ["project", "local"];
    args.push("--setting-sources", sources.join(","));
  }

  // Each spawned `claude` is an independent headless session. Strip the
  // nested-session markers so the harness still works when it is itself
  // launched from inside a Claude Code session.
  const childEnv = { ...process.env };
  delete childEnv.CLAUDECODE;
  delete childEnv.CLAUDE_CODE_SSE_PORT;
  delete childEnv.CLAUDE_CODE_ENTRYPOINT;

  debug("claude-code", "spawning `claude` subprocess", { args });
  installProcessCleanup();
  return new Promise<RunClaudeCodeResult>((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
    });
    // Track this child so process-level teardown can kill it if the harness
    // exits mid-run. Removed again in the "close" / "error" handlers below.
    liveChildren.add(child);
    debug("claude-code", "subprocess spawned", { pid: child.pid });
    let sawFirstStdout = false;

    const toolUses: ClaudeCodeToolUse[] = [];
    let finalText = "";
    let numTurns = 0;
    let sawResult = false;
    let isError = false;
    let stderr = "";
    let stdoutBuf = "";
    let sessionId: string | undefined;

    const onAbort = () => child.kill("SIGTERM");
    if (opts.signal) {
      if (opts.signal.aborted) {
        child.kill("SIGTERM");
        reject(new Error("Claude Code run aborted"));
        return;
      }
      opts.signal.addEventListener("abort", onAbort);
    }
    const cleanup = () => {
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    };

    function handleEvent(evt: StreamEvent) {
      // Trace every stream event so we can see exactly what the subprocess is
      // doing between spawn and result — assistant text, tool calls, or nothing.
      debug("claude-code", "stream event", {
        type: evt.type,
        subtype: evt.subtype,
        blocks: evt.message?.content?.map((b) => b.type ?? "?"),
      });
      // Every event carries the session id (system/init first, then each
      // assistant/result event). Capture the latest so callers can --resume it.
      if (typeof evt.session_id === "string") sessionId = evt.session_id;
      if (evt.type === "assistant" && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block.type === "text" && block.text) {
            debug("claude-code", "assistant text", {
              preview: block.text.slice(0, 80),
            });
            opts.onToken?.(block.text);
          } else if (block.type === "tool_use" && block.name) {
            debug("claude-code", "tool_use", { name: block.name });
            const use: ClaudeCodeToolUse = {
              name: block.name,
              input: block.input,
            };
            toolUses.push(use);
            opts.onToolUse?.(use);
          }
        }
      } else if (evt.type === "result") {
        debug("claude-code", "result event", {
          subtype: evt.subtype,
          is_error: evt.is_error,
          num_turns: evt.num_turns,
        });
        sawResult = true;
        if (typeof evt.num_turns === "number") numTurns = evt.num_turns;
        isError =
          Boolean(evt.is_error) ||
          (typeof evt.subtype === "string" && evt.subtype !== "success");
        if (typeof evt.result === "string") finalText = evt.result;
      }
    }

    child.on("error", (err: NodeJS.ErrnoException) => {
      liveChildren.delete(child);
      cleanup();
      if (err.code === "ENOENT") {
        reject(
          new Error(
            "`claude` CLI not found on PATH. Install Claude Code, then authenticate " +
              "with `claude login` (subscription) or `claude setup-token` (long-lived token).",
          ),
        );
      } else {
        reject(err);
      }
    });

    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.stdout.on("data", (d: Buffer) => {
      if (!sawFirstStdout) {
        sawFirstStdout = true;
        debug("claude-code", "first stdout chunk received");
      }
      stdoutBuf += d.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          handleEvent(JSON.parse(trimmed) as StreamEvent);
        } catch {
          // Ignore non-JSON lines
        }
      }
    });

    child.on("close", (code) => {
      liveChildren.delete(child);
      cleanup();
      debug("claude-code", "subprocess closed", {
        code,
        sawResult,
        isError,
        numTurns,
        stderrLen: stderr.length,
      });
      if (stdoutBuf.trim()) {
        try {
          handleEvent(JSON.parse(stdoutBuf.trim()) as StreamEvent);
        } catch {
          // ignore trailing partial
        }
      }

      if (sawResult && !isError) {
        resolve({ text: finalText, toolUses, numTurns, sessionId });
      } else if (sawResult && isError) {
        reject(
          new Error(
            `Claude Code returned an error: ${finalText || stderr || "unknown error"}`,
          ),
        );
      } else {
        const authIssue = /api key|login|auth|unauthor|credential/i.test(
          stderr,
        );
        const hint = authIssue
          ? " — looks like an authentication issue; run `claude login` or set CLAUDE_CODE_OAUTH_TOKEN"
          : "";
        reject(
          new Error(
            `Claude Code exited (code ${code}) without a result${hint}.` +
              (stderr ? ` stderr: ${stderr.slice(-500)}` : ""),
          ),
        );
      }
    });

    child.stdin.write(opts.prompt);
    child.stdin.end();
  });
}

/**
 * Files with uncommitted changes (modified, added, or untracked), relative to
 * the repo root. Used to attribute on-disk changes to a sub-Claude run since the
 * subprocess edits files directly rather than through the harness's own tools.
 */
export function gitChangedFiles(cwd?: string): string[] {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
