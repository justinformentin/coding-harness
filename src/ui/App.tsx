import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { Header } from "./Header.js";
import { Checklist } from "./Checklist.js";
import { Log, type LogEntry } from "./Log.js";
import { Input } from "./Input.js";
import { PlanReview } from "./PlanReview.js";
import { runHarness, type HarnessEvent } from "../harness.js";
import type { ModelConfig, PlannerChecklistItem } from "../schemas.js";

type AppProps = {
  config: ModelConfig;
  initialPrompt?: string;
};

type Status =
  | "idle"
  | "planning"
  | "plan_review"
  | "executing"
  | "verifying"
  | "complete"
  | "error";

type PlanReviewState = {
  planPath: string;
  checklist: PlannerChecklistItem[];
};

export function App({ config, initialPrompt }: AppProps) {
  const { exit } = useApp();
  const [submitted, setSubmitted] = useState(false);
  const [status, setStatus] = useState<Status>(
    initialPrompt ? "planning" : "idle"
  );
  const [iteration, setIteration] = useState(0);
  const [maxIter, setMaxIter] = useState(10);
  const [checklist, setChecklist] = useState<PlannerChecklistItem[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [planReviewState, setPlanReviewState] =
    useState<PlanReviewState | null>(null);

  // Ref to hold the resolve function for the plan review promise
  const planReviewResolveRef = useRef<
    ((decision: "approve" | "reject") => void) | null
  >(null);

  const addLog = useCallback(
    (source: LogEntry["source"], message: string) => {
      setLogs((prev) => [...prev, { source, message }]);
    },
    []
  );

  const handleEvent = useCallback(
    (event: HarnessEvent) => {
      switch (event.type) {
        case "plan_start":
          setStatus("planning");
          addLog("system", "Creating checklist from prompt...");
          break;
        case "plan_complete":
          addLog("planner", `Created ${event.itemCount} checklist items`);
          break;
        case "plan_review":
          setStatus("plan_review");
          setChecklist([...event.checklist]);
          setPlanReviewState({
            planPath: event.planPath,
            checklist: event.checklist,
          });
          addLog(
            "system",
            `Plan ready — ${event.checklist.length} items. Plan saved to ${event.planPath}`
          );
          break;
        case "plan_approved":
          setStatus("executing");
          setPlanReviewState(null);
          addLog("system", "Plan approved — starting execution");
          break;
        case "plan_rejected":
          setStatus("error");
          setPlanReviewState(null);
          addLog("system", "Plan rejected — run cancelled");
          break;
        case "iteration_start":
          setStatus("executing");
          setIteration(event.iteration);
          setMaxIter(event.maxIterations);
          break;
        case "executor_start":
          addLog(
            "executor",
            `Working on: ${event.itemId} — ${event.itemDescription}`
          );
          // Add a streaming placeholder entry that tokens will append into
          setLogs((prev) => [
            ...prev,
            { source: "executor" as const, message: "", streaming: true },
          ]);
          break;
        case "executor_token":
          // Append the incoming token to the last streaming entry
          setLogs((prev) => {
            const updated = [...prev];
            const lastIdx = updated.length - 1;
            if (lastIdx >= 0 && updated[lastIdx].streaming) {
              updated[lastIdx] = {
                ...updated[lastIdx],
                // Keep only the last 200 chars to avoid blowing up the log line
                message: (updated[lastIdx].message + event.token).slice(-200),
              };
            }
            return updated;
          });
          break;
        case "executor_complete":
          // Close the streaming entry and replace with a summary
          setLogs((prev) => {
            const updated = [...prev];
            const lastIdx = updated.length - 1;
            if (lastIdx >= 0 && updated[lastIdx].streaming) {
              // Remove the streaming placeholder; summary comes next
              updated.splice(lastIdx, 1);
            }
            return updated;
          });
          if (event.toolCalls > 0) {
            addLog("executor", `Made ${event.toolCalls} tool call(s)`);
          }
          break;
        case "tool_result": {
          const truncated =
            event.output.length > 200
              ? event.output.slice(0, 200) + "..."
              : event.output;
          addLog(
            "tool",
            `${event.name} ${event.success ? "OK" : "FAIL"}: ${truncated}`
          );
          break;
        }
        case "verify_start":
          setStatus("verifying");
          addLog("system", "Running verification...");
          break;
        case "verify_complete": {
          const r = event.report;
          if (r.done) {
            addLog("verifier", `All items verified complete`);
          } else {
            addLog("verifier", `Incomplete: ${r.incompleteItems.join(", ")}`);
            if (r.missingEvidence.length > 0) {
              addLog(
                "verifier",
                `Missing: ${r.missingEvidence.join("; ")}`
              );
            }
          }
          // Update checklist from report
          setChecklist((prev) => {
            const updated = prev.map((item) => ({ ...item }));
            for (const id of event.report.completedItems) {
              const item = updated.find((i) => i.id === id);
              if (item) item.status = "done";
            }
            return updated;
          });
          break;
        }
        case "repair":
          addLog("system", `Repair: ${event.instruction}`);
          break;
        case "complete":
          setStatus("complete");
          setChecklist([...event.state.checklist]);
          addLog(
            "system",
            `Done! Run saved to .runs/${event.state.runId}`
          );
          break;
        case "max_iterations":
          setStatus("error");
          addLog(
            "error",
            `Max iterations reached. Run saved to .runs/${event.state.runId}`
          );
          break;
        case "error":
          setStatus("error");
          addLog("error", event.message);
          break;
      }
    },
    [addLog]
  );

  // Callback passed to runHarness that suspends until the user decides
  const onPlanReview = useCallback(
    (
      planPath: string,
      reviewChecklist: PlannerChecklistItem[]
    ): Promise<"approve" | "reject"> => {
      return new Promise((resolve) => {
        // Store the resolve fn; the PlanReview component calls it via handlePlanDecision
        planReviewResolveRef.current = resolve;
        // Ensure UI state is set (handleEvent will also set it, but be defensive)
        setPlanReviewState({ planPath, checklist: reviewChecklist });
        setStatus("plan_review");
      });
    },
    []
  );

  const handlePlanDecision = useCallback(
    (decision: "approve" | "reject") => {
      if (planReviewResolveRef.current) {
        planReviewResolveRef.current(decision);
        planReviewResolveRef.current = null;
      }
    },
    []
  );

  const startRun = useCallback(
    async (prompt: string) => {
      addLog("system", `Prompt: ${prompt}`);
      try {
        const state = await runHarness(prompt, config, handleEvent, {
          onPlanReview,
        });
        setChecklist([...state.checklist]);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        addLog("error", msg);
        setStatus("error");
      }
    },
    [config, handleEvent, addLog, onPlanReview]
  );

  const handleSubmit = useCallback(
    (value: string) => {
      if (!value.trim() || submitted) return;
      setSubmitted(true);
      startRun(value);
    },
    [submitted, startRun]
  );

  // Start automatically if initialPrompt was provided
  useEffect(() => {
    if (initialPrompt) {
      setSubmitted(true);
      startRun(initialPrompt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      exit();
    }
  });

  return (
    <Box flexDirection="column">
      <Header iteration={iteration} maxIterations={maxIter} status={status} />
      <Checklist items={checklist} />
      <Box
        borderStyle="single"
        borderColor="gray"
        flexDirection="column"
        minHeight={10}
      >
        <Log entries={logs} />
      </Box>
      {status === "plan_review" && planReviewState ? (
        <PlanReview
          planPath={planReviewState.planPath}
          checklist={planReviewState.checklist}
          onDecision={handlePlanDecision}
        />
      ) : (
        !submitted && <Input onSubmit={handleSubmit} />
      )}
      {(status === "complete" || status === "error") && (
        <Box paddingX={1}>
          <Text dimColor>Press Ctrl+C to exit</Text>
        </Box>
      )}
    </Box>
  );
}
