import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Animated "thinking…" placeholder shown while a stream has started but no
 *  tokens have arrived yet. Cycles a braille spinner and trailing dots. */
function Thinking() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(id);
  }, []);

  const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
  const dots = ".".repeat((Math.floor(frame / 3) % 3) + 1);

  return (
    <Text dimColor italic>
      {spinner} thinking{dots}
    </Text>
  );
}

export type LogEntry = {
  source: "planner" | "executor" | "tool" | "verifier" | "system" | "error";
  message: string;
  /** When true, this entry is still receiving streaming tokens and the last
   *  line should be rendered without a trailing newline indicator. */
  streaming?: boolean;
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
          <Text wrap="wrap">
            {entry.streaming && entry.message === "" ? (
              // No output yet — show an animated placeholder until the first
              // token lands, at which point the real text replaces it.
              <Thinking />
            ) : (
              entry.message
            )}
            {entry.streaming ? <Text dimColor>▌</Text> : null}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
