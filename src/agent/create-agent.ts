import { createRunContext } from "../core/context.js";
import type { RunStream, RunResult } from "../core/result.js";
import type { EventHandler, Message, ModelAdapter, RunContext, RunContextOptions, SchemaLike } from "../core/types.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { ToolDefinition } from "../tool/tool-types.js";
import { executeAgentRun } from "./agent-runner.js";
import type { StopPolicy } from "./stop-policy.js";

export type AgentInput = string | Message[];

export interface ToolPolicy {
  retries?: number;
  timeoutMs?: number;
}

export interface AgentRunOptions extends RunContextOptions {
  context?: RunContext;
  memory?: MemoryStore;
  threadId?: string;
}

type AgentOutputFromSchema<TSchema> = TSchema extends SchemaLike<infer TOutput>
  ? TOutput
  : string;

export interface CreateAgentOptions<
  TName extends string = string,
  TTools extends readonly ToolDefinition[] = readonly ToolDefinition[],
  TOutputSchema extends SchemaLike | undefined = undefined,
> {
  name: TName;
  instructions?: string;
  model: ModelAdapter;
  tools?: TTools;
  output?: TOutputSchema;
  stopPolicy?: Partial<StopPolicy>;
  toolPolicy?: ToolPolicy;
  memory?: MemoryStore;
}

export interface Agent<
  TOutput = string,
  TTools extends readonly ToolDefinition[] = readonly ToolDefinition[],
  TName extends string = string,
> {
  // Reasoning unit used by workflow steps.
  readonly name: TName;
  readonly instructions?: string;
  readonly model: ModelAdapter;
  readonly tools: TTools;
  run(input: AgentInput, options?: AgentRunOptions): Promise<RunResult<TOutput>>;
  stream(input: AgentInput, options?: AgentRunOptions): RunStream<TOutput>;
}

export type AgentOutput<TAgent> = TAgent extends Agent<infer TOutput, any, any>
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
  const TTools extends readonly ToolDefinition[] = readonly ToolDefinition[],
  TOutputSchema extends SchemaLike | undefined = undefined,
>(
  options: CreateAgentOptions<TName, TTools, TOutputSchema>
): Agent<AgentOutputFromSchema<TOutputSchema>, TTools, TName> {
  const tools = (options.tools ?? []) as TTools;

  return {
    name: options.name,
    instructions: options.instructions,
    model: options.model,
    tools,
    async run(input, runOptions) {
      const context = buildContext(runOptions);

      return executeAgentRun<AgentOutputFromSchema<TOutputSchema>>({
        name: options.name,
        instructions: options.instructions,
        model: options.model,
        tools,
        output: options.output as SchemaLike<AgentOutputFromSchema<TOutputSchema>> | undefined,
        stopPolicy: options.stopPolicy,
        toolPolicy: options.toolPolicy,
        input,
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

      const result = executeAgentRun<AgentOutputFromSchema<TOutputSchema>>({
        name: options.name,
        instructions: options.instructions,
        model: options.model,
        tools,
        output: options.output as SchemaLike<AgentOutputFromSchema<TOutputSchema>> | undefined,
        stopPolicy: options.stopPolicy,
        toolPolicy: options.toolPolicy,
        input,
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
