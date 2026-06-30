import { spawn, execFileSync } from "node:child_process";

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
};

type StreamEvent = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  num_turns?: number;
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
  opts: RunClaudeCodeOptions
): Promise<RunClaudeCodeResult> {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
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

  // Each spawned `claude` is an independent headless session. Strip the
  // nested-session markers so the harness still works when it is itself
  // launched from inside a Claude Code session.
  const childEnv = { ...process.env };
  delete childEnv.CLAUDECODE;
  delete childEnv.CLAUDE_CODE_SSE_PORT;
  delete childEnv.CLAUDE_CODE_ENTRYPOINT;

  return new Promise<RunClaudeCodeResult>((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
    });

    const toolUses: ClaudeCodeToolUse[] = [];
    let finalText = "";
    let numTurns = 0;
    let sawResult = false;
    let isError = false;
    let stderr = "";
    let stdoutBuf = "";

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
      if (evt.type === "assistant" && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block.type === "text" && block.text) {
            opts.onToken?.(block.text);
          } else if (block.type === "tool_use" && block.name) {
            const use: ClaudeCodeToolUse = {
              name: block.name,
              input: block.input,
            };
            toolUses.push(use);
            opts.onToolUse?.(use);
          }
        }
      } else if (evt.type === "result") {
        sawResult = true;
        if (typeof evt.num_turns === "number") numTurns = evt.num_turns;
        isError =
          Boolean(evt.is_error) ||
          (typeof evt.subtype === "string" && evt.subtype !== "success");
        if (typeof evt.result === "string") finalText = evt.result;
      }
    }

    child.on("error", (err: NodeJS.ErrnoException) => {
      cleanup();
      if (err.code === "ENOENT") {
        reject(
          new Error(
            "`claude` CLI not found on PATH. Install Claude Code, then authenticate " +
              "with `claude login` (subscription) or `claude setup-token` (long-lived token)."
          )
        );
      } else {
        reject(err);
      }
    });

    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.stdout.on("data", (d: Buffer) => {
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
      cleanup();
      if (stdoutBuf.trim()) {
        try {
          handleEvent(JSON.parse(stdoutBuf.trim()) as StreamEvent);
        } catch {
          // ignore trailing partial
        }
      }

      if (sawResult && !isError) {
        resolve({ text: finalText, toolUses, numTurns });
      } else if (sawResult && isError) {
        reject(
          new Error(
            `Claude Code returned an error: ${finalText || stderr || "unknown error"}`
          )
        );
      } else {
        const authIssue = /api key|login|auth|unauthor|credential/i.test(
          stderr
        );
        const hint = authIssue
          ? " — looks like an authentication issue; run `claude login` or set CLAUDE_CODE_OAUTH_TOKEN"
          : "";
        reject(
          new Error(
            `Claude Code exited (code ${code}) without a result${hint}.` +
              (stderr ? ` stderr: ${stderr.slice(-500)}` : "")
          )
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
    });
    return out
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
