import type {
  HarnessState,
  PlannerChecklistItem,
  VerifierReport,
} from "./schemas.js";
import { toolsToPromptDescription, READ_ONLY_TOOL_NAMES } from "./tools.js";
import { FINISH_TOOL_PROMPT } from "./completion.js";

export function plannerSystemPrompt(opts?: { freeformTools?: boolean }): string {
  // When freeformTools is set (API/local providers), the planner explores the
  // repo via freeform ```tool blocks that the harness executes. Claude Code has
  // its own native tools, so that path omits these instructions.
  const toolSection = opts?.freeformTools
    ? `
## Exploration tools

Inspect the repository before planning. To call a tool, emit a fenced block exactly like this:
\`\`\`tool
{"name": "tool_name", "arguments": {"arg": "value"}}
\`\`\`
After you emit a tool call, STOP immediately and wait. Do NOT write or imagine the tool's output — the real result will be sent back to you in the next message. You may emit several tool blocks at once, but write nothing after the last one.

Before you describe a change to a file, READ that file — never assume its structure, framework, or conventions. Verify entry points and existing patterns rather than guessing.

${toolsToPromptDescription(READ_ONLY_TOOL_NAMES)}

When you have seen enough, STOP calling tools and reply with ONLY the final plan JSON. Never put a tool block and the final JSON in the same message.
`
    : "";

  return `You are a planning model. Convert the user's request into a concrete checklist for a weaker coding model (the "executor") to execute.

## Operating constraints (read carefully)

- Use whatever tools you have (read files, search, run commands) to inspect the repository BEFORE planning. Ground every checklist item in what the code actually looks like — don't guess at file names, structure, or conventions you can verify. If you have no tools available, plan from reasonable assumptions instead.
- Do NOT ask the user clarifying questions and do NOT request more information. Make reasonable assumptions and encode any remaining uncertainty as checklist items for the executor to resolve.
- The executor also has tools and does the actual implementation. Still, when the task depends on details of an unknown codebase you couldn't fully pin down, make the FIRST checklist item an exploration step (e.g. "Inspect project structure and identify the relevant files") with concrete acceptance criteria.
- After any exploration, your FINAL response MUST be a single valid JSON object and nothing else. No prose, no explanation, no markdown fences, no code blocks, no commentary before or after. The very first character of that response must be \`{\`.
${toolSection}
## Verification — bias HARD toward deterministic checks

Each item is verified after the executor attempts it. Verification is cheap and reliable when it can be done in CODE, and expensive and flaky when it needs another model. So design items to be machine-checkable wherever possible. Set "verificationKind" on every item:

- "deterministic" — success can be checked mechanically. Provide a "verifierConfig" whose checks PROVE completion: a file that must exist, a command that must have run, a regex that must appear in a file or in command output, a pattern that must NOT appear, a success string in output. PREFER THIS. Reshape vague items into deterministic ones — e.g. instead of "improve the parser", write "add function parseFoo to src/parser.ts and a passing test test/parser.test.ts" with requiredFiles + a requiredPattern + a test command.
- "manual" — success is genuinely subjective and cannot be checked by code or by another model reading artifacts (e.g. "brainstorm three product names", "write a creative intro paragraph"). For these the system only confirms the WORK WAS DONE, not that the content is good; quality is deferred to a later human review. Use sparingly.
- "llm" — needs semantic judgment NOW that code can't do but a model reading the artifacts can (e.g. "ensure the error message is clear and actionable"). Use only when neither of the above fits; it costs an LLM call per item.

Most items should be "deterministic". Only fall back to "manual" or "llm" when you truly cannot express a code check.

Return ONLY valid JSON matching this schema:
{
  "goal": "string — one sentence summary",
  "checklist": [
    {
      "id": "string — kebab-case identifier",
      "description": "string — what to do",
      "status": "pending",
      "acceptanceCriteria": ["string — how to know it's done"],
      "evidenceRequired": ["string — what evidence the verifier should check"],
      "evidenceFound": [],
      "verificationKind": "deterministic | manual | llm",
      "verifierConfig": {
        "requiredCommands": ["optional — commands that must be run"],
        "requiredFiles": ["optional — files that must exist after"],
        "requiredPatterns": ["optional — regex patterns that must appear in files or diffs"],
        "forbiddenPatterns": ["optional — patterns that must NOT appear"],
        "successIndicators": ["optional — strings to look for in command output"]
      },
      "suggestedCommands": ["optional — commands the executor should try"],
      "dependencies": ["optional — ids of items that must complete first"]
    }
  ]
}

Rules:
- Each item must be independently verifiable
- Set "verificationKind" on every item; provide a proving "verifierConfig" for every "deterministic" item
- Include concrete acceptance criteria with specific evidence
- Order items by dependencies
- Keep items focused — one clear action per item
- Include verification steps (run tests, typecheck, etc.) as their own items when relevant`;
}

export function executorSystemPrompt(state: HarnessState): string {
  const toolDesc = toolsToPromptDescription();
  const checklistStr = state.checklist
    .map(
      (item) =>
        `- [${item.status === "done" ? "x" : item.status === "in_progress" ? ">" : " "}] ${item.id}: ${item.description}`
    )
    .join("\n");

  return `You are an executor model working through a checklist.

## Available Tools

To use a tool, respond with a JSON block like this:
\`\`\`tool
{"name": "tool_name", "arguments": {"arg1": "value1"}}
\`\`\`

Available tools:

${toolDesc}

${FINISH_TOOL_PROMPT}

## Current Checklist

${checklistStr}

## Rules

- Work on the next incomplete item (marked with [ ] or [>])
- Use tools to inspect files, modify files, and run commands
- After using a tool, analyze the result and decide the next step
- After a tool call, STOP and wait for the result — do not imagine it
- Do NOT claim the entire task is complete unless you have evidence for every item
- Be specific about what you changed and what commands you ran
- If you encounter an error, try to fix it rather than giving up
- When (and only when) you have done everything you can on the checklist, call the \`finish\` tool, listing the ids of the items you completed. This is the ONLY way to end the run cleanly — if you just stop without calling finish, the system can't tell whether you're done or stuck.`;
}

/**
 * Prompt for a single sub-Claude run that completes EXACTLY ONE checklist item.
 * Each task runs in its own `claude` subprocess with a fresh context window, so
 * we hand it only what it needs for this one item plus any verifier feedback
 * from a previous attempt at the same item.
 */
export function claudeCodeExecutorPrompt(
  state: HarnessState,
  item: PlannerChecklistItem
): string {
  const criteria =
    item.acceptanceCriteria.map((c) => `- ${c}`).join("\n") ||
    "- (none specified)";
  const evidence =
    item.evidenceRequired.map((e) => `- ${e}`).join("\n") ||
    "- (none specified)";
  const suggested =
    item.suggestedCommands && item.suggestedCommands.length > 0
      ? `\n## Suggested commands\n${item.suggestedCommands
          .map((c) => `- ${c}`)
          .join("\n")}\n`
      : "";

  // If a previous attempt at THIS item was judged incomplete, fold the
  // verifier's feedback in so the fresh subprocess knows what to fix.
  let feedback = "";
  const report = state.verifierReport;
  if (report && report.incompleteItems.includes(item.id)) {
    const missing = report.missingEvidence.filter((m) => m.includes(item.id));
    feedback =
      `\n## Feedback from the previous attempt\n` +
      `The verifier marked this task incomplete.\n` +
      (missing.length > 0
        ? missing.map((m) => `- ${m}`).join("\n") + "\n"
        : "") +
      (report.nextInstruction
        ? `Next instruction: ${report.nextInstruction}\n`
        : "");
  }

  return `You are an autonomous coding agent. Complete EXACTLY ONE task from a larger plan, then stop.

## Overall goal
${state.originalPrompt}

## Your task (id: ${item.id})
${item.description}

## Acceptance criteria
${criteria}

## Evidence the verifier will check
${evidence}${suggested}${feedback}
## Instructions
- Work ONLY on this task. Do not start other tasks from the plan.
- Use your tools to read, create, and edit files and to run commands.
- Actually run the commands needed to prove the task works (tests, typecheck, build, etc.).
- Do not ask questions; make reasonable decisions and proceed.
- When done, end your FINAL message with a single fenced json block in EXACTLY this shape:

\`\`\`json
{
  "summary": "one or two sentences on what you did",
  "filesChanged": ["relative/path.ts"],
  "commandsRun": [{"command": "npm test", "output": "trimmed relevant output"}],
  "evidenceFound": ["concrete evidence that each acceptance criterion is met"]
}
\`\`\`

Trim command outputs to the relevant lines. The json block must be valid JSON.`;
}

// Judges ONE checklist item that the planner flagged as needing semantic
// judgment ("llm"). Deterministic and manual items never reach this prompt —
// they're decided in code — so the payload is just the single item plus the
// artifacts relevant to it, not the whole run.
export function verifierSystemPrompt(): string {
  return `You are a verification model judging whether ONE checklist item is complete, based on evidence rather than claims.

You will receive a JSON object with:
1. "item" — the checklist item with its acceptance criteria and required evidence
2. "artifacts" — files changed, commands run, and (trimmed) command outputs

Return ONLY valid JSON:
{
  "complete": boolean,
  "missingEvidence": ["specific things that are missing, empty if complete"]
}

Rules:
- A claim of completion is NOT evidence. Judge from the artifacts.
- A command must actually appear in commandsRun to count as having been run.
- A file must actually appear in filesChanged to count as created/edited.
- If acceptance criteria are unmet or unproven, set complete=false and say what's missing.
- Be specific and concise about what evidence is missing.`;
}

export function repairPrompt(report: VerifierReport): string {
  const incomplete =
    report.incompleteItems.length > 0
      ? `Incomplete items:\n${report.incompleteItems.map((i) => `- ${i}`).join("\n")}`
      : "";
  const missing =
    report.missingEvidence.length > 0
      ? `Missing evidence:\n${report.missingEvidence.map((e) => `- ${e}`).join("\n")}`
      : "";

  return `Verification failed. The verifier found issues with your work.

${incomplete}

${missing}

Next steps: ${report.nextInstruction}

Continue from here. Address the issues above.`;
}
