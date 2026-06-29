import { existsSync, readFileSync } from "fs";
import { chat } from "./llm.js";
import { verifierSystemPrompt } from "./prompts.js";
import {
  VerifierReportSchema,
  type HarnessState,
  type VerifierReport,
  type RoleModelConfig,
} from "./schemas.js";

export async function verify(
  state: HarnessState,
  config: RoleModelConfig
): Promise<VerifierReport> {
  // Layer 1: Deterministic checks
  const deterministicResults = await runDeterministicChecks(state);

  // Layer 2: Artifact checks
  const artifactResults = checkArtifacts(state);

  // Combine layers 1 & 2
  const allDeterministicPassed =
    deterministicResults.incompleteItems.length === 0 &&
    artifactResults.incompleteItems.length === 0;
  const combinedIncomplete = [
    ...new Set([
      ...deterministicResults.incompleteItems,
      ...artifactResults.incompleteItems,
    ]),
  ];
  const combinedMissing = [
    ...deterministicResults.missingEvidence,
    ...artifactResults.missingEvidence,
  ];
  const combinedComplete = [
    ...new Set([
      ...deterministicResults.completedItems,
      ...artifactResults.completedItems,
    ]),
  ];

  // If deterministic checks are conclusive, skip LLM judge
  if (
    allDeterministicPassed &&
    state.checklist.every((item) => combinedComplete.includes(item.id))
  ) {
    return {
      done: true,
      completedItems: combinedComplete,
      incompleteItems: [],
      missingEvidence: [],
      nextInstruction: "",
    };
  }

  // If there are clear failures, we can also skip LLM judge
  if (combinedIncomplete.length > 0 && combinedMissing.length > 0) {
    return {
      done: false,
      completedItems: combinedComplete,
      incompleteItems: combinedIncomplete,
      missingEvidence: combinedMissing,
      nextInstruction: `Address the following: ${combinedMissing.join("; ")}`,
    };
  }

  // Layer 3: LLM judge for ambiguous cases
  return llmJudge(
    state,
    config,
    combinedComplete,
    combinedIncomplete,
    combinedMissing
  );
}

async function runDeterministicChecks(state: HarnessState): Promise<{
  completedItems: string[];
  incompleteItems: string[];
  missingEvidence: string[];
}> {
  const completed: string[] = [];
  const incomplete: string[] = [];
  const missing: string[] = [];

  for (const item of state.checklist) {
    if (item.status === "done") {
      completed.push(item.id);
      continue;
    }

    const verifierConfig = item.verifierConfig;
    if (!verifierConfig) continue;

    let itemPassed = true;
    let hasChecks = false;

    // Check required files
    if (verifierConfig.requiredFiles && verifierConfig.requiredFiles.length > 0) {
      hasChecks = true;
      for (const file of verifierConfig.requiredFiles) {
        if (!existsSync(file)) {
          missing.push(`File not found: ${file} (required by ${item.id})`);
          itemPassed = false;
        }
      }
    }

    // Check required commands were run
    if (verifierConfig.requiredCommands && verifierConfig.requiredCommands.length > 0) {
      hasChecks = true;
      for (const cmd of verifierConfig.requiredCommands) {
        const wasRun = state.artifacts.commandsRun.some((c) =>
          c.includes(cmd)
        );
        if (!wasRun) {
          missing.push(
            `Command not run: "${cmd}" (required by ${item.id})`
          );
          itemPassed = false;
        }
      }
    }

    // Check required patterns in files or command outputs
    if (verifierConfig.requiredPatterns && verifierConfig.requiredPatterns.length > 0) {
      hasChecks = true;
      for (const pattern of verifierConfig.requiredPatterns) {
        const regex = new RegExp(pattern);
        const foundInFiles = state.artifacts.filesChanged.some((f) => {
          try {
            const content = readFileSync(f, "utf-8");
            return regex.test(content);
          } catch {
            return false;
          }
        });
        const foundInOutput = state.artifacts.commandOutputs.some((o) =>
          regex.test(o)
        );
        if (!foundInFiles && !foundInOutput) {
          missing.push(
            `Pattern not found: "${pattern}" (required by ${item.id})`
          );
          itemPassed = false;
        }
      }
    }

    // Check forbidden patterns
    if (verifierConfig.forbiddenPatterns && verifierConfig.forbiddenPatterns.length > 0) {
      hasChecks = true;
      for (const pattern of verifierConfig.forbiddenPatterns) {
        const regex = new RegExp(pattern, "i");
        for (const file of state.artifacts.filesChanged) {
          try {
            const content = readFileSync(file, "utf-8");
            if (regex.test(content)) {
              missing.push(
                `Forbidden pattern found: "${pattern}" in ${file} (violation in ${item.id})`
              );
              itemPassed = false;
            }
          } catch {
            // file unreadable, skip
          }
        }
      }
    }

    // Check success indicators in command output
    if (verifierConfig.successIndicators && verifierConfig.successIndicators.length > 0) {
      hasChecks = true;
      for (const indicator of verifierConfig.successIndicators) {
        const found = state.artifacts.commandOutputs.some((o) =>
          o.includes(indicator)
        );
        if (!found) {
          missing.push(
            `Success indicator not found in output: "${indicator}" (required by ${item.id})`
          );
          itemPassed = false;
        }
      }
    }

    if (hasChecks) {
      if (itemPassed) {
        completed.push(item.id);
      } else {
        incomplete.push(item.id);
      }
    }
  }

  return { completedItems: completed, incompleteItems: incomplete, missingEvidence: missing };
}

function checkArtifacts(state: HarnessState): {
  completedItems: string[];
  incompleteItems: string[];
  missingEvidence: string[];
} {
  const completed: string[] = [];
  const incomplete: string[] = [];
  const missing: string[] = [];

  for (const item of state.checklist) {
    if (item.status === "done") continue;
    if (item.evidenceRequired.length === 0) continue;

    // Check if evidenceRequired is satisfied by evidenceFound
    const unmetEvidence = item.evidenceRequired.filter(
      (req) =>
        !item.evidenceFound.some((found) =>
          found.toLowerCase().includes(req.toLowerCase())
        )
    );

    if (unmetEvidence.length === 0) {
      completed.push(item.id);
    } else {
      incomplete.push(item.id);
      missing.push(
        ...unmetEvidence.map((e) => `${item.id}: missing evidence "${e}"`)
      );
    }
  }

  return { completedItems: completed, incompleteItems: incomplete, missingEvidence: missing };
}

async function llmJudge(
  state: HarnessState,
  config: RoleModelConfig,
  alreadyComplete: string[],
  alreadyIncomplete: string[],
  alreadyMissing: string[],
): Promise<VerifierReport> {
  const prompt = JSON.stringify({
    checklist: state.checklist,
    artifacts: state.artifacts,
    deterministicResults: {
      completedItems: alreadyComplete,
      incompleteItems: alreadyIncomplete,
      missingEvidence: alreadyMissing,
    },
  });

  const { content } = await chat(config, verifierSystemPrompt(), [
    { role: "user", content: prompt },
  ]);

  const jsonStr = content.match(/\{[\s\S]*\}/)?.[0] || content;
  try {
    const parsed = JSON.parse(jsonStr) as unknown;
    const result = VerifierReportSchema.safeParse(parsed);
    if (result.success) return result.data;
  } catch {
    // fall through to fallback
  }

  // Fallback if LLM judge returns garbage
  return {
    done: false,
    completedItems: alreadyComplete,
    incompleteItems:
      alreadyIncomplete.length > 0
        ? alreadyIncomplete
        : state.checklist
            .filter((i) => i.status !== "done")
            .map((i) => i.id),
    missingEvidence:
      alreadyMissing.length > 0
        ? alreadyMissing
        : ["Verifier could not parse LLM judge response"],
    nextInstruction:
      "Continue working on incomplete items. Provide clear evidence for each.",
  };
}
