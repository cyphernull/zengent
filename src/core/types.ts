import type { ZodType } from "zod";

export interface SchemaLike<T = unknown> {
  parse(value: unknown): T;
}

export type InferSchema<TSchema> = TSchema extends SchemaLike<infer TOutput>
  ? TOutput
  : never;

export type ZodSchema<T = unknown> = ZodType<T>;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface JsonSchema {
  [key: string]: JsonValue | undefined;
}

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: MessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolCall<TInput = unknown> {
  id: string;
  name: string;
  input: TInput;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema?: JsonSchema;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ModelRequest<TOutput = unknown> {
  instructions?: string;
  messages: Message[];
  tools?: ToolDescriptor[];
  outputSchema?: SchemaLike<TOutput>;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface ModelResponse<TOutput = unknown> {
  text?: string;
  output?: TOutput;
  toolCalls?: ToolCall[];
  finishReason?: "stop" | "tool_calls" | "length" | "error";
  usage?: Usage;
  raw?: unknown;
}

export interface ModelStream<TOutput = unknown> extends AsyncIterable<string> {
  result: Promise<ModelResponse<TOutput>>;
  textStream: AsyncIterable<string>;
}

export interface ModelAdapter {
  name: string;
  generate<TOutput = unknown>(
    request: ModelRequest<TOutput>,
    context: RunContext
  ): Promise<ModelResponse<TOutput>>;
  streamGenerate?<TOutput = unknown>(
    request: ModelRequest<TOutput>,
    context: RunContext
  ): ModelStream<TOutput>;
}

export type EventHandler = (event: RunEvent) => void | Promise<void>;

type DistributiveOmit<TValue, TKey extends PropertyKey> = TValue extends unknown
  ? Omit<TValue, TKey>
  : never;

export interface RunContextOptions {
  runId?: string;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
  onEvent?: EventHandler;
  now?: () => Date;
}

export interface RunContext {
  readonly runId: string;
  readonly signal?: AbortSignal;
  readonly metadata: Record<string, unknown>;
  readonly now: () => Date;
  readonly onEvent?: EventHandler;
  emit(event: DistributiveOmit<RunEvent, "runId" | "timestamp">): Promise<void>;
  child(overrides?: Partial<RunContextOptions>): RunContext;
  nextId(prefix?: string): string;
}

export type RunEvent =
  | {
      type: "run.started";
      runId: string;
      timestamp: string;
      name: string;
      input: unknown;
    }
  | {
      type: "run.completed";
      runId: string;
      timestamp: string;
      name: string;
      status: "success" | "failed";
    }
  | {
      type: "model.started";
      runId: string;
      timestamp: string;
      adapter: string;
      step: number;
      messages: Message[];
    }
  | {
      type: "model.completed";
      runId: string;
      timestamp: string;
      adapter: string;
      step: number;
      response: ModelResponse;
    }
  | {
      type: "tool.started";
      runId: string;
      timestamp: string;
      tool: string;
      callId: string;
      input: unknown;
      attempt: number;
    }
  | {
      type: "tool.completed";
      runId: string;
      timestamp: string;
      tool: string;
      callId: string;
      output: unknown;
      attempt: number;
    }
  | {
      type: "tool.failed";
      runId: string;
      timestamp: string;
      tool: string;
      callId: string;
      error: string;
      attempt: number;
    }
  | {
      type: "flow.node.started";
      runId: string;
      timestamp: string;
      flow: string;
      node: string;
      nodeType: "agent" | "process" | "parallel";
      input: unknown;
    }
  | {
      type: "flow.node.completed";
      runId: string;
      timestamp: string;
      flow: string;
      node: string;
      nodeType: "agent" | "process" | "parallel";
      output: unknown;
    }
  | {
      type: "flow.node.failed";
      runId: string;
      timestamp: string;
      flow: string;
      node: string;
      nodeType: "agent" | "process" | "parallel";
      error: string;
    };
