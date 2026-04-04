import type { ZodType } from "zod";

import { createRunContext } from "../core/context.js";
import type { RunStream, RunResult } from "../core/result.js";
import { ValidationError } from "../core/errors.js";
import type { EventHandler, ModelAdapter, RunContext, RunContextOptions, ZodSchema, InferSchema } from "../core/types.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { ToolDefinition } from "../tool/tool-types.js";
import { executeAgentRun } from "./agent-runner.js";
import type { StopPolicy } from "./stop-policy.js";

export interface ToolPolicy {
  retries?: number;
  timeoutMs?: number;
}

export interface AgentRunOptions extends RunContextOptions {
  context?: RunContext;
  memory?: MemoryStore;
  threadId?: string;
}

export interface AgentPromptArgs<TInput> {
  input: TInput;
}

export interface CreateAgentOptions<
  TName extends string = string,
  TInputSchema extends ZodType = ZodType,
  TOutputSchema extends ZodType = ZodType,
  TTools extends readonly ToolDefinition[] = readonly ToolDefinition[],
> {
  name: TName;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  instructions?: string;
  prompt?: (
    args: AgentPromptArgs<InferSchema<TInputSchema>>
  ) => string;
  model: ModelAdapter;
  tools?: TTools;
  stopPolicy?: Partial<StopPolicy>;
  toolPolicy?: ToolPolicy;
  memory?: MemoryStore;
}

export interface Agent<
  TInput = unknown,
  TOutput = unknown,
  TTools extends readonly ToolDefinition[] = readonly ToolDefinition[],
  TName extends string = string,
> {
  // Reasoning unit used by flows.
  readonly name: TName;
  readonly inputSchema: ZodSchema<TInput>;
  readonly outputSchema: ZodSchema<TOutput>;
  readonly instructions?: string;
  readonly prompt?: (args: AgentPromptArgs<TInput>) => string;
  readonly model: ModelAdapter;
  readonly tools: TTools;
  run(input: TInput, options?: AgentRunOptions): Promise<RunResult<TOutput>>;
  stream(input: TInput, options?: AgentRunOptions): RunStream<TOutput>;
}

export type AgentInput<TAgent> = TAgent extends Agent<infer TInput, any, any, any>
  ? TInput
  : never;

export type AgentOutput<TAgent> = TAgent extends Agent<any, infer TOutput, any, any>
  ? TOutput
  : never;

function createEventQueue() {
  const values: import("../core/types.js").RunEvent[] = [];
  const resolvers: Array<(value: IteratorResult<import("../core/types.js").RunEvent>) => void> = [];
  let finished = false;

  return {
    push(value: import("../core/types.js").RunEvent) {
      const resolver = resolvers.shift();

      if (resolver) {
        resolver({ done: false, value });
        return;
      }

      values.push(value);
    },
    finish() {
      finished = true;

      while (resolvers.length > 0) {
        const resolver = resolvers.shift();
        resolver?.({ done: true, value: undefined });
      }
    },
    async *stream() {
      while (!finished || values.length > 0) {
        if (values.length > 0) {
          yield values.shift() as import("../core/types.js").RunEvent;
          continue;
        }

        const result = await new Promise<IteratorResult<import("../core/types.js").RunEvent>>(
          (resolve) => {
            resolvers.push(resolve);
          }
        );

        if (result.done) {
          return;
        }

        yield result.value;
      }
    },
  };
}

function mergeEventHandlers(
  left?: EventHandler,
  right?: EventHandler
): EventHandler | undefined {
  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  return async (event) => {
    await left(event);
    await right(event);
  };
}

function buildContext(options?: AgentRunOptions): RunContext {
  if (options?.context) {
    if (!options.onEvent) {
      return options.context;
    }

    return options.context.child({
      signal: options.signal,
      metadata: options.metadata,
      onEvent: mergeEventHandlers(options.context.onEvent, options.onEvent),
    });
  }

  return createRunContext(options);
}

export function createAgent<
  const TName extends string,
  TInputSchema extends ZodType,
  TOutputSchema extends ZodType,
  const TTools extends readonly ToolDefinition[] = readonly ToolDefinition[],
>(
  options: CreateAgentOptions<TName, TInputSchema, TOutputSchema, TTools>
): Agent<InferSchema<TInputSchema>, InferSchema<TOutputSchema>, TTools, TName> {
  const tools = (options.tools ?? []) as TTools;

  return {
    name: options.name,
    inputSchema: options.inputSchema as ZodSchema<InferSchema<TInputSchema>>,
    outputSchema: options.outputSchema as ZodSchema<InferSchema<TOutputSchema>>,
    instructions: options.instructions,
    prompt: options.prompt,
    model: options.model,
    tools,
    async run(input, runOptions) {
      const context = buildContext(runOptions);
      let parsedInput: InferSchema<TInputSchema>;

      try {
        parsedInput = options.inputSchema.parse(input) as InferSchema<TInputSchema>;
      } catch (error) {
        return {
          status: "failed",
          error: new ValidationError(`Invalid input for agent "${options.name}".`, {
            cause: error,
          }),
          steps: [],
          toolTraces: [],
          messages: [],
        };
      }

      return executeAgentRun<InferSchema<TInputSchema>, InferSchema<TOutputSchema>>({
        name: options.name,
        instructions: options.instructions,
        prompt: options.prompt,
        model: options.model,
        tools,
        outputSchema: options.outputSchema as ZodSchema<InferSchema<TOutputSchema>>,
        stopPolicy: options.stopPolicy,
        toolPolicy: options.toolPolicy,
        input: parsedInput,
        context,
        memory: options.memory,
        runOptions,
      });
    },
    stream(input, runOptions) {
      const queue = createEventQueue();
      const context = buildContext({
        ...runOptions,
        onEvent: mergeEventHandlers(runOptions?.onEvent, async (event) => {
          queue.push(event);
        }),
      });
      let parsedInput: InferSchema<TInputSchema>;

      try {
        parsedInput = options.inputSchema.parse(input) as InferSchema<TInputSchema>;
      } catch (error) {
        const failed = Promise.resolve({
          status: "failed" as const,
          error: new ValidationError(`Invalid input for agent "${options.name}".`, {
            cause: error,
          }),
          steps: [],
          toolTraces: [],
          messages: [],
        });
        queue.finish();

        return {
          result: failed,
          [Symbol.asyncIterator]() {
            return queue.stream();
          },
        };
      }

      const result = executeAgentRun<InferSchema<TInputSchema>, InferSchema<TOutputSchema>>({
        name: options.name,
        instructions: options.instructions,
        prompt: options.prompt,
        model: options.model,
        tools,
        outputSchema: options.outputSchema as ZodSchema<InferSchema<TOutputSchema>>,
        stopPolicy: options.stopPolicy,
        toolPolicy: options.toolPolicy,
        input: parsedInput,
        context,
        memory: options.memory,
        runOptions: {
          ...runOptions,
          context,
        },
      }).finally(() => {
        queue.finish();
      });

      return {
        result,
        [Symbol.asyncIterator]() {
          return queue.stream();
        },
      };
    },
  };
}
