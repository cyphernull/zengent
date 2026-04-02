export interface ToolTrace {
  name: string;
  callId: string;
  input: unknown;
  output?: unknown;
  error?: string;
  attempt: number;
}

export interface StepTrace {
  name: string;
  type: "model" | "tool" | "workflow";
  input?: unknown;
  output?: unknown;
  error?: string;
}

export interface RunBaseResult {
  status: "success" | "failed" | "paused";
  steps: StepTrace[];
  toolTraces: ToolTrace[];
  messages: unknown[];
}

export interface SuccessRunResult<TOutput> extends RunBaseResult {
  status: "success";
  output: TOutput;
  text?: string;
}

export interface FailedRunResult extends RunBaseResult {
  status: "failed";
  error: Error;
}

export interface PausedRunResult<TState = unknown> extends RunBaseResult {
  status: "paused";
  state: TState;
  reason?: string;
}

export type RunResult<TOutput, TPausedState = unknown> =
  | SuccessRunResult<TOutput>
  | FailedRunResult
  | PausedRunResult<TPausedState>;

export interface RunStream<TOutput, TPausedState = unknown>
  extends AsyncIterable<import("./types.js").RunEvent> {
  result: Promise<RunResult<TOutput, TPausedState>>;
}
