import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { Glob } from "bun";

export async function readFileTool(args: { path: string }): Promise<string> {
  try {
    const content = await readFile(args.path, "utf-8");
    return content;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to read ${args.path}: ${msg}`);
  }
}

export async function writeFileTool(args: {
  path: string;
  content: string;
}): Promise<string> {
  try {
    await mkdir(dirname(args.path), { recursive: true });
    await writeFile(args.path, args.content, "utf-8");
    return `Wrote ${args.path}`;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to write ${args.path}: ${msg}`);
  }
}

export async function editFileTool(args: {
  path: string;
  old: string;
  new: string;
}): Promise<string> {
  try {
    const content = await readFile(args.path, "utf-8");
    if (!content.includes(args.old)) {
      throw new Error(
        `String not found in ${args.path}: "${args.old.slice(0, 50)}..."`
      );
    }
    const updated = content.replace(args.old, args.new);
    await writeFile(args.path, updated, "utf-8");
    return `Edited ${args.path}`;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to edit ${args.path}: ${msg}`);
  }
}

export async function listFilesTool(args: {
  path: string;
  pattern?: string;
}): Promise<string> {
  try {
    const glob = new Glob(args.pattern || "**/*");
    const results: string[] = [];
    for await (const file of glob.scan({ cwd: args.path, onlyFiles: true })) {
      results.push(file);
    }
    return results.join("\n");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to list files in ${args.path}: ${msg}`);
  }
}
