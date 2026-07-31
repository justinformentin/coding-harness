import { spawn } from "child_process";
import { createHash } from "crypto";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { resolve } from "path";
import type { Assertion } from "./contracts/plan.js";
import type { HarnessState, PlannerChecklistItem } from "./schemas.js";
import { gitChangedFiles } from "./claude-code.js";

export type AssertionStatus = "passed" | "failed" | "human_review";
export type AssertionResult = {
  assertion: number;
  kind: Assertion["kind"];
  status: AssertionStatus;
  expected: string;
  actual: string;
  stdout?: string;
};
export type StepVerification = {
  stepId: string;
  status: AssertionStatus;
  assertions: AssertionResult[];
  failures: string[];
};

/** Content-sensitive workspace evidence used by no-progress detection. */
export async function captureWorkspaceDiff(
  workspaceRoot: string,
): Promise<string> {
  const changed = gitChangedFiles(workspaceRoot).sort();
  const entries: string[] = [];
  for (const path of changed) {
    try {
      const bytes = await readFile(resolve(workspaceRoot, path));
      entries.push(
        `${path}:${createHash("sha256").update(bytes).digest("hex")}`,
      );
    } catch {
      entries.push(`${path}:deleted`);
    }
  }
  return entries.join("\n");
}

async function runArgv(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<{ code: number; stdout: string }> {
  return new Promise((done) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, shell: false });
    const chunks: Buffer[] = [];
    let finished = false;
    let bytes = 0;
    const collect = (value: Buffer) => {
      if (bytes >= maxOutputBytes) return;
      chunks.push(value.subarray(0, maxOutputBytes - bytes));
      bytes += value.length;
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const finish = (code: number, suffix = "") => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done({ code, stdout: Buffer.concat(chunks).toString() + suffix });
    };
    child.on("error", (error) => finish(-1, error.message));
    child.on("close", (code) => finish(code ?? -1));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(-1, `\ncommand timed out after ${timeoutMs}ms`);
    }, timeoutMs);
  });
}

export async function verifyStepAssertions(
  item: PlannerChecklistItem,
  state: HarnessState,
  workspaceRoot = process.cwd(),
  commandTimeoutMs = 120_000,
  maxOutputBytes = 100_000,
): Promise<StepVerification> {
  const assertions = item.assertions;
  if (!assertions.length)
    return {
      stepId: item.id,
      status: "failed",
      assertions: [],
      failures: [`${item.id}: no assertions`],
    };
  const results: AssertionResult[] = [];

  for (let index = 0; index < assertions.length; index++) {
    const assertion = assertions[index];
    if (assertion.kind === "human_review") {
      results.push({
        assertion: index,
        kind: assertion.kind,
        status: "human_review",
        expected: assertion.instructions,
        actual: "awaiting human review",
      });
      continue;
    }
    if (assertion.kind === "file_exists") {
      const found = existsSync(resolve(workspaceRoot, assertion.path));
      results.push({
        assertion: index,
        kind: assertion.kind,
        status: found ? "passed" : "failed",
        expected: assertion.path,
        actual: found ? "exists" : "missing",
      });
      continue;
    }
    if (
      assertion.kind === "file_matches" ||
      assertion.kind === "file_not_matches"
    ) {
      let content = "";
      try {
        content = await readFile(
          resolve(workspaceRoot, assertion.path),
          "utf8",
        );
      } catch {}
      let matched = false;
      try {
        matched = new RegExp(assertion.pattern).test(content);
      } catch (error) {
        results.push({
          assertion: index,
          kind: assertion.kind,
          status: "failed",
          expected: assertion.pattern,
          actual: `invalid regex: ${String(error)}`,
        });
        continue;
      }
      const passed = assertion.kind === "file_matches" ? matched : !matched;
      results.push({
        assertion: index,
        kind: assertion.kind,
        status: passed ? "passed" : "failed",
        expected: assertion.pattern,
        actual: matched ? "matched" : "did not match",
      });
      continue;
    }
    if (assertion.kind === "git_diff") {
      const changed = gitChangedFiles(workspaceRoot);
      const passed = assertion.path
        ? changed.includes(assertion.path)
        : changed.length > 0;
      results.push({
        assertion: index,
        kind: assertion.kind,
        status: passed ? "passed" : "failed",
        expected: assertion.path ?? "any workspace diff",
        actual: changed.join(", ") || "no changes",
      });
      continue;
    }
    if (assertion.kind === "command") {
      const command = await runArgv(
        assertion.argv,
        workspaceRoot,
        commandTimeoutMs,
        maxOutputBytes,
      );
      results.push({
        assertion: index,
        kind: assertion.kind,
        status: command.code === assertion.exitCode ? "passed" : "failed",
        expected: `${JSON.stringify(assertion.argv)} exits ${assertion.exitCode}`,
        actual: `exit ${command.code}`,
        stdout: command.stdout,
      });
      continue;
    }
    const source = results[Number(assertion.from.replace(/^assertion:/, ""))];
    const output = source?.stdout ?? "";
    const passed = output.includes(assertion.contains);
    results.push({
      assertion: index,
      kind: assertion.kind,
      status: passed ? "passed" : "failed",
      expected: assertion.contains,
      actual: output,
    });
  }

  const failures = results
    .filter((result) => result.status === "failed")
    .map(
      (result) =>
        `${item.id} assertion:${result.assertion} ${result.kind}: expected ${result.expected}; ${result.actual}`,
    );
  const status = failures.length
    ? "failed"
    : results.some((result) => result.status === "human_review")
      ? "human_review"
      : "passed";
  return { stepId: item.id, status, assertions: results, failures };
}
