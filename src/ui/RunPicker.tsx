import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { RunSummary } from "../run-store.js";

type RunPickerProps = {
  runs: RunSummary[];
  onSelect: (runId: string) => void;
  onCancel: () => void;
};

export function RunPicker({ runs, onSelect, onCancel }: RunPickerProps) {
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.ctrl) return;
    if (key.upArrow || input === "k") {
      setCursor((c) => (c - 1 + runs.length) % runs.length);
    } else if (key.downArrow || input === "j") {
      setCursor((c) => (c + 1) % runs.length);
    } else if (key.return) {
      onSelect(runs[cursor].runId);
    } else if (key.escape || input.toLowerCase() === "q") {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          ═══ Select a run to resume ═══
        </Text>
      </Box>

      {runs.map((run, idx) => {
        const selected = idx === cursor;
        const progress =
          run.totalItems > 0
            ? `${run.doneItems}/${run.totalItems} items, iter ${run.iteration}/${run.maxIterations}`
            : run.hasState
              ? `iter ${run.iteration}/${run.maxIterations}`
              : "no checkpoint";
        return (
          <Box key={run.runId} flexDirection="column">
            <Text color={selected ? "cyan" : undefined} bold={selected}>
              {selected ? "❯ " : "  "}
              {run.runId} <Text dimColor>({progress})</Text>
            </Text>
            <Box paddingLeft={4}>
              <Text dimColor wrap="truncate-end">
                {run.prompt}
              </Text>
            </Box>
          </Box>
        );
      })}

      <Box marginTop={1}>
        <Text dimColor>
          ↑/↓ to move · Enter to resume · q/Esc to cancel
        </Text>
      </Box>
    </Box>
  );
}
