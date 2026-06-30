import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

type InputProps = {
  onSubmit: (value: string) => void;
  placeholder?: string;
};

export function Input({ onSubmit, placeholder = "Enter your prompt..." }: InputProps) {
  const [value, setValue] = useState("");

  useInput((input, key) => {
    if (key.return) {
      if (value.trim()) {
        onSubmit(value.trim());
        // Clear so the field is ready for the next message (e.g. steering the
        // running loop). Previously the input unmounted after the first submit
        // so this never mattered.
        setValue("");
      }
      return;
    }
    if (key.backspace || key.delete) {
      setValue((prev) => prev.slice(0, -1));
      return;
    }
    // Ignore control keys
    if (key.ctrl || key.meta) return;
    setValue((prev) => prev + input);
  });

  return (
    <Box paddingX={1}>
      <Text bold color="green">
        {">"}{" "}
      </Text>
      <Text>
        {value || <Text dimColor>{placeholder}</Text>}
      </Text>
      <Text color="green">_</Text>
    </Box>
  );
}
