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
  type: "model" | "tool" | "flow" | "process" | "parallel";
  input?: unknown;
  output?: unknown;
  error?: string;
}

export interface RunBaseResult {
  status: "success" | "failed";
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
export type RunResult<TOutput> = SuccessRunResult<TOutput> | FailedRunResult;

export interface RunStream<TOutput> extends AsyncIterable<string> {
  result: Promise<RunResult<TOutput>>;
  textStream: AsyncIterable<string>;
}

export interface FlowTextChunk {
  node: string;
  text: string;
}

export interface FlowRunStream<TOutput> extends AsyncIterable<FlowTextChunk> {
  result: Promise<RunResult<TOutput>>;
  textStream: AsyncIterable<FlowTextChunk>;
}
