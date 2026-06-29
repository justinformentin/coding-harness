import React from "react";
import { Box, Text } from "ink";

type HeaderProps = {
  iteration: number;
  maxIterations: number;
  status:
    | "idle"
    | "planning"
    | "executing"
    | "verifying"
    | "complete"
    | "error";
};

export function Header({ iteration, maxIterations, status }: HeaderProps) {
  const statusColors: Record<string, string> = {
    idle: "gray",
    planning: "yellow",
    executing: "blue",
    verifying: "magenta",
    complete: "green",
    error: "red",
  };

  return (
    <Box
      borderStyle="single"
      paddingX={1}
      flexDirection="row"
      justifyContent="space-between"
    >
      <Text bold>coding-harness</Text>
      <Box gap={2}>
        <Text color={statusColors[status] || "white"}>{status}</Text>
        {iteration > 0 && (
          <Text dimColor>
            iteration {iteration}/{maxIterations}
          </Text>
        )}
      </Box>
    </Box>
  );
}
