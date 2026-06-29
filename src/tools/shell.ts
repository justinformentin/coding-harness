import { $ } from "bun";

export async function runCommandTool(args: {
  command: string;
  cwd?: string;
  timeout?: number;
}): Promise<string> {
  const timeout = args.timeout || 30000;
  try {
    // Use AbortController for timeout since bun-types may not expose .timeout()
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    const result = await $`bash -c ${args.command}`
      .cwd(args.cwd || process.cwd())
      .quiet()
      .nothrow()
      .finally(() => clearTimeout(timer));

    const stdout = result.stdout.toString().trim();
    const stderr = result.stderr.toString().trim();
    const output = [stdout, stderr].filter(Boolean).join("\n");

    if (result.exitCode !== 0) {
      return `[exit code ${result.exitCode}]\n${output}`;
    }
    return output || "(no output)";
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("timeout") || msg.includes("Timeout")) {
      throw new Error(
        `Command timed out after ${timeout}ms: ${args.command}`
      );
    }
    throw new Error(`Command failed: ${msg}`);
  }
}
