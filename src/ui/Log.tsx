import React from "react";
import { Box, Text } from "ink";

export type LogEntry = {
  source: "planner" | "executor" | "tool" | "verifier" | "system" | "error";
  message: string;
};

type LogProps = {
  entries: LogEntry[];
  maxLines?: number;
};

const SOURCE_COLORS: Record<string, string> = {
  planner: "cyan",
  executor: "blue",
  tool: "yellow",
  verifier: "magenta",
  system: "gray",
  error: "red",
};

export function Log({ entries, maxLines = 20 }: LogProps) {
  const visible = entries.slice(-maxLines);

  return (
    <Box flexDirection="column" paddingX={1}>
      {visible.map((entry, i) => (
        <Box key={i} gap={1}>
          <Text color={SOURCE_COLORS[entry.source]}>[{entry.source}]</Text>
          <Text wrap="truncate-end">{entry.message}</Text>
        </Box>
      ))}
    </Box>
  );
}
