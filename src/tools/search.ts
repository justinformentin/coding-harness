import { $ } from "bun";

export async function grepTool(args: {
  pattern: string;
  path?: string;
  include?: string;
}): Promise<string> {
  const searchPath = args.path || ".";
  let cmd = `grep -rn "${args.pattern}" ${searchPath}`;
  if (args.include) cmd += ` --include="${args.include}"`;

  try {
    const result = await $`bash -c ${cmd}`.quiet().nothrow();
    const output = result.stdout.toString().trim();
    return output || "No matches found";
  } catch {
    return "No matches found";
  }
}

export async function gitDiffTool(): Promise<string> {
  try {
    const result = await $`git diff`.quiet().nothrow();
    const output = result.stdout.toString().trim();
    return output || "(no changes)";
  } catch {
    return "(not a git repository or git not available)";
  }
}
