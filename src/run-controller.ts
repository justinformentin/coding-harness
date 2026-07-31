import { createHash } from "crypto";
import type { StopReason } from "./contracts/result.js";
import type { HarnessState, ResolvedConfig } from "./schemas.js";

export interface AttemptObservation {
  stepId: string;
  modelCalls: number;
  toolCalls: number;
  failures: string[];
  workspaceDiff: string;
}

export interface RunController {
  beforeAttempt(stepId: string, signal?: AbortSignal): StopReason | undefined;
  recordAttempt(observation: AttemptObservation): StopReason | undefined;
}

/** Owns durable counters and every finite loop termination decision. */
export class DeterministicRunController implements RunController {
  constructor(
    private readonly state: HarnessState,
    private readonly config: ResolvedConfig,
  ) {}

  beforeAttempt(stepId: string, signal?: AbortSignal): StopReason | undefined {
    if (signal?.aborted)
      return signal.reason === "deadline" ? "deadline" : "cancelled";
    if (
      Date.now() - this.state.startedAt >=
      this.config.loop.deadlineSeconds * 1000
    )
      return "deadline";
    if (this.state.modelCalls >= this.config.loop.maxModelCalls)
      return "max_model_calls";
    if (this.state.toolCalls >= this.config.loop.maxToolCalls)
      return "max_tool_calls";
    if (
      (this.state.stepAttempts[stepId] ?? 0) >=
      this.config.loop.maxAttemptsPerStep
    )
      return "max_attempts";
    return undefined;
  }

  recordAttempt(observation: AttemptObservation): StopReason | undefined {
    this.state.iteration++;
    this.state.modelCalls += observation.modelCalls;
    this.state.toolCalls += observation.toolCalls;
    this.state.stepAttempts[observation.stepId] =
      (this.state.stepAttempts[observation.stepId] ?? 0) + 1;

    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          completed: this.state.checklist
            .filter((item) => item.status === "passed")
            .map((item) => item.id)
            .sort(),
          failures: [...observation.failures].sort(),
          workspaceDiff: observation.workspaceDiff,
        }),
      )
      .digest("hex");
    this.state.noProgressCount =
      fingerprint === this.state.progressFingerprint
        ? this.state.noProgressCount + 1
        : 0;
    this.state.progressFingerprint = fingerprint;

    if (this.state.toolCalls >= this.config.loop.maxToolCalls)
      return "max_tool_calls";
    if (this.state.modelCalls >= this.config.loop.maxModelCalls)
      return "max_model_calls";
    if (this.state.noProgressCount >= this.config.loop.noProgressAttempts)
      return "no_progress";
    return undefined;
  }
}
