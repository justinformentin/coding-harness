import React, { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import type { Session } from "../App";

// Raw HarnessEvent as persisted in events.jsonl (plus the recorded timestamp).
// Kept loose on purpose — we only read the fields we render.
interface HarnessEvent {
  type: string;
  timestamp?: number;
  [key: string]: unknown;
}

// A single rendered transcript line.
interface Entry {
  source: string;
  text: string;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function detailSuffix(ev: HarnessEvent): string {
  const detail = ev.detail as string | undefined;
  return detail ? ` — ${detail}` : "";
}

// Turn a persisted HarnessEvent into a transcript line, mirroring what the TUI
// log shows. Returns null for events with nothing worth displaying.
function formatEvent(ev: HarnessEvent): Entry | null {
  switch (ev.type) {
    case "run_init":
      return {
        source: "system",
        text: `Run started (${String(ev.runId ?? "")})`,
      };
    case "plan_start":
      return { source: "system", text: "Creating checklist from prompt…" };
    case "plan_tool":
      return { source: "tool", text: `${String(ev.name)}${detailSuffix(ev)}` };
    case "plan_complete":
      return {
        source: "planner",
        text: `Created ${String(ev.itemCount)} checklist items`,
      };
    case "plan_review":
      return {
        source: "system",
        text: `Plan ready — ${(ev.checklist as unknown[])?.length ?? 0} items`,
      };
    case "plan_approved":
      return { source: "system", text: "Plan approved — starting execution" };
    case "plan_rejected":
      return { source: "system", text: "Plan rejected — run cancelled" };
    case "iteration_start":
      return {
        source: "system",
        text: `Iteration ${String(ev.iteration)}${
          ev.maxIterations ? `/${String(ev.maxIterations)}` : ""
        }`,
      };
    case "step_transition":
      return {
        source: "system",
        text: `${String(ev.stepId)}: ${String(ev.from)} → ${String(ev.to)}`,
      };
    case "steering":
      return { source: "user", text: `Steering: ${String(ev.message)}` };
    case "executor_start":
      return {
        source: "executor",
        text: `Working on: ${String(ev.itemId)} — ${String(ev.itemDescription)}`,
      };
    case "executor_tool":
      return { source: "tool", text: `${String(ev.name)}${detailSuffix(ev)}` };
    case "executor_complete": {
      // The full assistant response is persisted here — the real content that
      // state.messages only stored a summary of.
      const response = String(ev.response ?? "").trim();
      if (!response) {
        const n = Number(ev.toolCalls ?? 0);
        return n > 0
          ? { source: "executor", text: `Made ${n} tool call(s)` }
          : null;
      }
      return { source: "executor", text: response };
    }
    case "tool_result":
      return {
        source: "tool",
        text: `${String(ev.name)} ${ev.success ? "OK" : "FAIL"}: ${truncate(
          String(ev.output ?? ""),
          2000,
        )}`,
      };
    case "verify_start":
      return { source: "system", text: "Running verification…" };
    case "verify_complete": {
      const r = (ev.report ?? {}) as {
        done?: boolean;
        incompleteItems?: string[];
        missingEvidence?: string[];
        nextInstruction?: string;
        assertionResults?: Array<{
          stepId: string;
          actual: string;
          confidence: string;
        }>;
      };
      if (r.done)
        return { source: "verifier", text: "All items verified complete" };
      const parts: string[] = [];
      if (r.incompleteItems?.length)
        parts.push(`Incomplete: ${r.incompleteItems.join(", ")}`);
      if (r.missingEvidence?.length)
        parts.push(`Missing: ${r.missingEvidence.join("; ")}`);
      if (r.nextInstruction) parts.push(`Next: ${r.nextInstruction}`);
      for (const result of r.assertionResults ?? [])
        if (result.confidence === "model")
          parts.push(
            `Model judgment (${result.stepId}, lower confidence): ${result.actual}`,
          );
      return { source: "verifier", text: parts.join("\n") || "Incomplete" };
    }
    case "repair":
      return {
        source: "system",
        text: `Repair: ${String(ev.instruction ?? "")}`,
      };
    case "complete":
      return { source: "system", text: "Done! Run complete." };
    case "stopped":
      return { source: "system", text: "Run stopped." };
    case "max_iterations":
      return { source: "error", text: "Max iterations reached." };
    case "budget_exhausted":
      return {
        source: "error",
        text: `Run stopped: ${String(ev.reason ?? "budget exhausted")}`,
      };
    case "blocked":
      return { source: "error", text: "Run blocked by unmet dependencies." };
    case "attempt_complete":
      return null;
    case "model_call_start":
    case "model_call_end":
    case "tool_call_start":
    case "tool_call_end":
      return null;
    case "parse_failure":
      return {
        source: "system",
        text: `${String(ev.role)} parse failed; evidence artifact: ${String(ev.artifact)}`,
      };
    case "context_compacted":
      return {
        source: "system",
        text: `Compacted ${String(ev.removedMessages)} message(s) for ${String(ev.stepId)}; artifact: ${String(ev.artifact)}`,
      };
    case "error":
      return { source: "error", text: String(ev.message ?? "error") };
    default:
      return null;
  }
}

interface ChatViewProps {
  onSessionCreated?: (session: Session) => void;
}

export default function ChatView({ onSessionCreated }: ChatViewProps) {
  const { id } = useParams<{ id: string }>();
  // No :id param means this is a draft (the "New session" view) — empty
  // transcript, waiting for the first message to create the run.
  const isDraft = !id;
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  // Whether the harness loop is still actively executing (polled from the
  // server). Drives the Send ↔ Stop button toggle.
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const fetchEvents = () => {
    if (!id) return;
    fetch(`/api/sessions/${id}/events`)
      .then((r) => r.json())
      .then((data) => {
        const events: HarnessEvent[] = data.events ?? [];
        setEntries(
          events.map(formatEvent).filter((e): e is Entry => e !== null),
        );
      })
      .catch(() => {});
  };

  const fetchStatus = () => {
    if (!id) return;
    fetch(`/api/sessions/${id}/status`)
      .then((r) => r.json())
      .then((data) => {
        setRunning(Boolean(data.running));
        // Once the server confirms the run has stopped, clear the transient
        // "stopping…" flag so the button settles into its idle state.
        if (!data.running) setStopping(false);
      })
      .catch(() => {});
  };

  useEffect(() => {
    // A fresh draft view: clear any leftover transcript from a prior session.
    if (isDraft) {
      setEntries([]);
      setRunning(false);
      setStopping(false);
      return;
    }
    fetchEvents();
    fetchStatus();
    const interval = setInterval(() => {
      fetchEvents();
      fetchStatus();
    }, 2000);
    return () => clearInterval(interval);
  }, [id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries]);

  const sendMessage = async () => {
    if (!input.trim() || sending) return;
    setSending(true);
    try {
      if (isDraft) {
        // First message of a draft: create the run with this as its prompt.
        const promptText = input.trim();
        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: promptText }),
        });
        const data = await res.json();
        if (data.id) {
          setInput("");
          setRunning(true);
          onSessionCreated?.({
            id: data.id,
            prompt: promptText,
            startedAt: Date.now(),
          });
        }
        return;
      }

      await fetch(`/api/sessions/${id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Server expects { content } — this is the steering message injected at
        // the next iteration boundary.
        body: JSON.stringify({ content: input.trim() }),
      });
      setInput("");
      fetchEvents();
    } finally {
      setSending(false);
    }
  };

  // Stop the running agent/loop: aborts the harness and tears down any live
  // sub-`claude` subprocesses server-side. Optimistically flips the button so
  // the UI feels responsive; the status poll confirms shortly after.
  const stopRun = async () => {
    if (!id || stopping) return;
    setStopping(true);
    try {
      await fetch(`/api/sessions/${id}/stop`, { method: "POST" });
      setRunning(false);
      fetchEvents();
    } catch {
      // Let the next status poll reconcile if the request failed.
      setStopping(false);
    }
  };

  // The primary button acts as Stop only while the run is live AND the box is
  // empty. As soon as the user types, it reverts to Send so they can steer the
  // running agent instead of stopping it.
  const showStop = !isDraft && running && !input.trim();

  const handlePrimaryAction = () => {
    if (showStop) {
      stopRun();
    } else {
      sendMessage();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="chat-view">
      <h2>{isDraft ? "New session" : `Session: ${id}`}</h2>
      <div className="messages-scroll">
        {isDraft && entries.length === 0 && (
          <div className="empty-state">
            Describe the task to start a new session.
          </div>
        )}
        {entries.map((entry, i) => (
          <div key={i} className={`message message--${entry.source}`}>
            <span className="role">{entry.source}</span>
            <pre>{entry.text}</pre>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <div className="chat-input-area">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isDraft
              ? "Describe the task… (Cmd+Enter to start)"
              : "Steer the agent… (Cmd+Enter to send, applies next iteration)"
          }
          disabled={sending}
        />
        <button
          onClick={handlePrimaryAction}
          disabled={showStop ? stopping : sending || !input.trim()}
          className={showStop ? "stop-button" : undefined}
        >
          {isDraft
            ? "Start"
            : showStop
              ? stopping
                ? "Stopping…"
                : "Stop"
              : "Send"}
        </button>
      </div>
    </div>
  );
}
