import React from "react";
import { Box, Text } from "ink";
import type { PlannerChecklistItem } from "../schemas.js";

type ChecklistProps = {
  items: PlannerChecklistItem[];
};

const STATUS_ICONS: Record<string, string> = {
  pending: "○",
  in_progress: "◆",
  done: "✓",
  failed: "✗",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "gray",
  in_progress: "yellow",
  done: "green",
  failed: "red",
};

export function Checklist({ items }: ChecklistProps) {
  if (items.length === 0) return null;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      {items.map((item) => (
        <Box key={item.id} gap={1}>
          <Text color={STATUS_COLORS[item.status]}>
            {STATUS_ICONS[item.status]}
          </Text>
          <Text color={STATUS_COLORS[item.status]}>{item.id}</Text>
          <Text dimColor>— {item.description}</Text>
        </Box>
      ))}
    </Box>
  );
}
