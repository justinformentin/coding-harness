import React from "react";
import { Box, Text, useInput } from "ink";
import type { PlannerChecklistItem } from "../schemas.js";

type PlanReviewProps = {
  planPath: string;
  checklist: PlannerChecklistItem[];
  onDecision: (decision: "approve" | "reject") => void;
};

export function PlanReview({ planPath, checklist, onDecision }: PlanReviewProps) {
  useInput((input, key) => {
    if (key.ctrl) return;
    const ch = input.toLowerCase();
    if (ch === "y") {
      onDecision("approve");
    } else if (ch === "n") {
      onDecision("reject");
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          ═══ Plan Review ═══
        </Text>
      </Box>

      {checklist.map((item, idx) => (
        <Box key={item.id} flexDirection="column" marginBottom={1}>
          <Text bold color="white">
            {idx + 1}. {item.id}
          </Text>
          <Box paddingLeft={2} flexDirection="column">
            <Text wrap="wrap">
              <Text dimColor>Description: </Text>
              {item.description}
            </Text>

            {item.acceptanceCriteria.length > 0 && (
              <Box flexDirection="column">
                <Text dimColor>Acceptance Criteria:</Text>
                {item.acceptanceCriteria.map((c, i) => (
                  <Box key={i} paddingLeft={2}>
                    <Text wrap="wrap">• {c}</Text>
                  </Box>
                ))}
              </Box>
            )}

            {item.evidenceRequired.length > 0 && (
              <Box flexDirection="column">
                <Text dimColor>Evidence Required:</Text>
                {item.evidenceRequired.map((e, i) => (
                  <Box key={i} paddingLeft={2}>
                    <Text wrap="wrap">• {e}</Text>
                  </Box>
                ))}
              </Box>
            )}

            {item.suggestedCommands && item.suggestedCommands.length > 0 && (
              <Box flexDirection="column">
                <Text dimColor>Suggested Commands:</Text>
                {item.suggestedCommands.map((cmd, i) => (
                  <Box key={i} paddingLeft={2}>
                    <Text color="green" wrap="wrap">
                      $ {cmd}
                    </Text>
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        </Box>
      ))}

      <Box
        borderStyle="single"
        borderColor="yellow"
        paddingX={1}
        marginTop={1}
      >
        <Text>
          Plan saved to{" "}
          <Text color="cyan">{planPath}</Text>
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text bold color="yellow">
          Approve this plan? (y/n){" "}
        </Text>
        <Text dimColor>
          y = start execution, n = reject and exit
        </Text>
      </Box>
    </Box>
  );
}
