import {
  readFileTool,
  writeFileTool,
  editFileTool,
  listFilesTool,
} from "./tools/files.js";
import { runCommandTool } from "./tools/shell.js";
import { grepTool, gitDiffTool } from "./tools/search.js";

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<
    string,
    { type: string; description: string; required?: boolean }
  >;
  execute: (args: Record<string, unknown>) => Promise<string>;
};

export const tools: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a file's contents",
    parameters: {
      path: { type: "string", description: "File path to read", required: true },
    },
    execute: (args) => readFileTool(args as { path: string }),
  },
  {
    name: "write_file",
    description: "Create or overwrite a file",
    parameters: {
      path: {
        type: "string",
        description: "File path to write",
        required: true,
      },
      content: {
        type: "string",
        description: "File content",
        required: true,
      },
    },
    execute: (args) =>
      writeFileTool(args as { path: string; content: string }),
  },
  {
    name: "edit_file",
    description: "Find and replace text in a file",
    parameters: {
      path: {
        type: "string",
        description: "File path to edit",
        required: true,
      },
      old: {
        type: "string",
        description: "Text to find",
        required: true,
      },
      new: {
        type: "string",
        description: "Text to replace with",
        required: true,
      },
    },
    execute: (args) =>
      editFileTool(args as { path: string; old: string; new: string }),
  },
  {
    name: "list_files",
    description:
      "List files in a directory, optionally filtered by glob pattern",
    parameters: {
      path: {
        type: "string",
        description: "Directory path",
        required: true,
      },
      pattern: { type: "string", description: "Glob pattern (default: **/*)" },
    },
    execute: (args) =>
      listFilesTool(args as { path: string; pattern?: string }),
  },
  {
    name: "run_command",
    description: "Run a shell command and return stdout/stderr",
    parameters: {
      command: {
        type: "string",
        description: "Shell command to run",
        required: true,
      },
      cwd: { type: "string", description: "Working directory" },
    },
    execute: (args) =>
      runCommandTool(args as { command: string; cwd?: string }),
  },
  {
    name: "grep",
    description: "Search file contents with regex",
    parameters: {
      pattern: {
        type: "string",
        description: "Regex pattern to search",
        required: true,
      },
      path: { type: "string", description: "Directory to search in" },
      include: {
        type: "string",
        description: "File pattern filter (e.g. *.ts)",
      },
    },
    execute: (args) =>
      grepTool(args as { pattern: string; path?: string; include?: string }),
  },
  {
    name: "git_diff",
    description: "Show current git diff",
    parameters: {},
    execute: () => gitDiffTool(),
  },
];

export function getToolByName(name: string): ToolDefinition | undefined {
  return tools.find((t) => t.name === name);
}

// Tools that only inspect the repository — safe for the planner to use during
// exploration without mutating the working tree.
export const READ_ONLY_TOOL_NAMES = [
  "read_file",
  "list_files",
  "grep",
  "git_diff",
];

export function toolsToPromptDescription(names?: string[]): string {
  const list = names ? tools.filter((t) => names.includes(t.name)) : tools;
  return list
    .map((t) => {
      const params = Object.entries(t.parameters)
        .map(
          ([name, p]) =>
            `  - ${name} (${p.type}${p.required ? ", required" : ""}): ${p.description}`
        )
        .join("\n");
      return `### ${t.name}\n${t.description}\n${params ? `Parameters:\n${params}` : "No parameters"}`;
    })
    .join("\n\n");
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ success: boolean; output: string }> {
  const tool = getToolByName(name);
  if (!tool) return { success: false, output: `Unknown tool: ${name}` };
  try {
    const output = await tool.execute(args);
    return { success: true, output };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, output: msg };
  }
}
