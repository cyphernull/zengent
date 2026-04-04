import { createRunContext } from "../core/context.js";
import { ConfigError, FlowExecutionError, ValidationError } from "../core/errors.js";
import type { RunResult, StepTrace, ToolTrace } from "../core/result.js";
import type { EventHandler, InferSchema, RunContext, RunContextOptions, SchemaLike } from "../core/types.js";
import type { Agent, AgentOutput } from "../agent/create-agent.js";
import type { MemoryStore } from "../memory/memory-store.js";

type AnyAgent = Agent<any, any, readonly any[], string>;

type FlowResultsRecord = Record<string, unknown>;

export interface FlowRunOptions extends RunContextOptions {
  memory?: MemoryStore;
  threadId?: string;
}

export interface ProcessContext<TInput> {
  input: TInput;
  ctx: RunContext;
}

export interface ProcessDefinition<
  TInputSchema extends SchemaLike = SchemaLike,
  TOutputSchema extends SchemaLike = SchemaLike,
  TName extends string = string,
> {
  readonly kind: "process";
  readonly name: TName;
  readonly inputSchema: TInputSchema;
  readonly outputSchema: TOutputSchema;
  run(
    context: ProcessContext<InferSchema<TInputSchema>>
  ): Promise<InferSchema<TOutputSchema>> | InferSchema<TOutputSchema>;
}

export interface DefineProcessOptions<
  TInputSchema extends SchemaLike,
  TOutputSchema extends SchemaLike,
  TName extends string = string,
> {
  name: TName;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  run(
    context: ProcessContext<InferSchema<TInputSchema>>
  ): Promise<InferSchema<TOutputSchema>> | InferSchema<TOutputSchema>;
}

export function defineProcess<
  const TName extends string,
  TInputSchema extends SchemaLike,
  TOutputSchema extends SchemaLike,
>(
  options: DefineProcessOptions<TInputSchema, TOutputSchema, TName>
): ProcessDefinition<TInputSchema, TOutputSchema, TName> {
  return {
    kind: "process",
    name: options.name,
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema,
    run: options.run,
  };
}

type ParallelOutputs<TAgents extends Record<string, AnyAgent>> = {
  [TKey in keyof TAgents]: AgentOutput<TAgents[TKey]>;
};

interface BaseFlowNode {
  name: string;
  kind: "agent" | "process" | "parallel";
}

interface AgentFlowNode<TAgent extends AnyAgent> extends BaseFlowNode {
  kind: "agent";
  agent: TAgent;
}

interface ProcessFlowNode<
  TInputSchema extends SchemaLike = SchemaLike,
  TOutputSchema extends SchemaLike = SchemaLike,
> extends BaseFlowNode {
  kind: "process";
  process: ProcessDefinition<TInputSchema, TOutputSchema>;
}

interface ParallelFlowNode<TAgents extends Record<string, AnyAgent>> extends BaseFlowNode {
  kind: "parallel";
  agents: TAgents;
}

type FlowNode =
  | AgentFlowNode<AnyAgent>
  | ProcessFlowNode
  | ParallelFlowNode<Record<string, AnyAgent>>;

export interface FlowFinalizeContext<TInput, TResults extends FlowResultsRecord> {
  originalInput: TInput;
  results: Readonly<TResults>;
}

export interface Flow<
  TInput = unknown,
  TOutput = unknown,
  TResults extends FlowResultsRecord = FlowResultsRecord,
  TName extends string = string,
> {
  readonly name: TName;
  readonly inputSchema: SchemaLike<TInput>;
  readonly outputSchema: SchemaLike<TOutput>;
  run(input: unknown, options?: FlowRunOptions): Promise<RunResult<TOutput>>;
}

interface FlowBuilderState<
  TInput,
  TOutput,
  TResults extends FlowResultsRecord,
  TPrevious,
  TName extends string,
> {
  name: TName;
  inputSchema: SchemaLike<TInput>;
  outputSchema: SchemaLike<TOutput>;
  nodes: FlowNode[];
  onFinalize?: (flow: Flow<TInput, TOutput, TResults, TName>) => void;
  finalizeFn?: (context: FlowFinalizeContext<TInput, TResults>) => Promise<TOutput> | TOutput;
  lastContext?: {
    memory?: MemoryStore;
    threadId?: string;
  };
  _previous?: TPrevious;
}

export interface FlowBuilderApi<
  TInput,
  TOutput,
  TResults extends FlowResultsRecord,
  TPrevious,
  TName extends string,
> {
  agent<const TNodeName extends string, TAgent extends AnyAgent>(
    name: TNodeName,
    agent: TAgent
  ): FlowBuilderApi<
    TInput,
    TOutput,
    TResults & Record<TNodeName, AgentOutput<TAgent>>,
    AgentOutput<TAgent>,
    TName
  >;
  process<
    const TNodeName extends string,
    TInputSchema extends SchemaLike,
    TOutputSchema extends SchemaLike,
  >(
    name: TNodeName,
    options: Omit<DefineProcessOptions<TInputSchema, TOutputSchema, TNodeName>, "name">
  ): FlowBuilderApi<
    TInput,
    TOutput,
    TResults & Record<TNodeName, InferSchema<TOutputSchema>>,
    InferSchema<TOutputSchema>,
    TName
  >;
  parallel<const TNodeName extends string, TAgents extends Record<string, AnyAgent>>(
    name: TNodeName,
    agents: TAgents
  ): FlowBuilderApi<
    TInput,
    TOutput,
    TResults & Record<TNodeName, ParallelOutputs<TAgents>>,
    ParallelOutputs<TAgents>,
    TName
  >;
  finalize(
    fn: (context: FlowFinalizeContext<TInput, TResults>) => Promise<TOutput> | TOutput
  ): Flow<TInput, TOutput, TResults, TName>;
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

function assertUniqueNodeName(nodes: readonly FlowNode[], name: string) {
  if (nodes.some((node) => node.name === name)) {
    throw new ConfigError(`Duplicate flow node named "${name}".`);
  }
}

class FlowBuilder<
  TInput,
  TOutput,
  TResults extends FlowResultsRecord,
  TPrevious,
  TName extends string,
> implements FlowBuilderApi<TInput, TOutput, TResults, TPrevious, TName> {
  constructor(
    private readonly state: FlowBuilderState<TInput, TOutput, TResults, TPrevious, TName>
  ) {}

  agent<const TNodeName extends string, TAgent extends AnyAgent>(
    name: TNodeName,
    agent: TAgent
  ): FlowBuilder<
    TInput,
    TOutput,
    TResults & Record<TNodeName, AgentOutput<TAgent>>,
    AgentOutput<TAgent>,
    TName
  > {
    assertUniqueNodeName(this.state.nodes, name);
    this.state.nodes.push({
      kind: "agent",
      name,
      agent,
    });

    return this as unknown as FlowBuilder<
      TInput,
      TOutput,
      TResults & Record<TNodeName, AgentOutput<TAgent>>,
      AgentOutput<TAgent>,
      TName
    >;
  }

  process<
    const TNodeName extends string,
    TInputSchema extends SchemaLike,
    TOutputSchema extends SchemaLike,
  >(
    name: TNodeName,
    options: Omit<DefineProcessOptions<TInputSchema, TOutputSchema, TNodeName>, "name">
  ): FlowBuilder<
    TInput,
    TOutput,
    TResults & Record<TNodeName, InferSchema<TOutputSchema>>,
    InferSchema<TOutputSchema>,
    TName
  > {
    assertUniqueNodeName(this.state.nodes, name);
    this.state.nodes.push({
      kind: "process",
      name,
      process: defineProcess({
        name,
        ...options,
      }),
    });

    return this as unknown as FlowBuilder<
      TInput,
      TOutput,
      TResults & Record<TNodeName, InferSchema<TOutputSchema>>,
      InferSchema<TOutputSchema>,
      TName
    >;
  }

  parallel<const TNodeName extends string, TAgents extends Record<string, AnyAgent>>(
    name: TNodeName,
    agents: TAgents
  ): FlowBuilder<
    TInput,
    TOutput,
    TResults & Record<TNodeName, ParallelOutputs<TAgents>>,
    ParallelOutputs<TAgents>,
    TName
  > {
    assertUniqueNodeName(this.state.nodes, name);
    this.state.nodes.push({
      kind: "parallel",
      name,
      agents,
    });

    return this as unknown as FlowBuilder<
      TInput,
      TOutput,
      TResults & Record<TNodeName, ParallelOutputs<TAgents>>,
      ParallelOutputs<TAgents>,
      TName
    >;
  }

  finalize(
    fn: (context: FlowFinalizeContext<TInput, TResults>) => Promise<TOutput> | TOutput
  ): Flow<TInput, TOutput, TResults, TName> {
    this.state.finalizeFn = fn;
    const flow = createRunnableFlow(this.state);
    this.state.onFinalize?.(flow);
    return flow;
  }
}

function createRunnableFlow<
  TInput,
  TOutput,
  TResults extends FlowResultsRecord,
  TPrevious,
  TName extends string,
>(
  state: FlowBuilderState<TInput, TOutput, TResults, TPrevious, TName>
): Flow<TInput, TOutput, TResults, TName> {
  return {
    name: state.name,
    inputSchema: state.inputSchema,
    outputSchema: state.outputSchema,
    async run(rawInput, options = {}) {
      if (!state.finalizeFn) {
        throw new ConfigError(`Flow "${state.name}" must be finalized before it can run.`);
      }

      const mergedOnEvent = mergeEventHandlers(options.onEvent, undefined);
      const context = createRunContext({
        runId: options.runId,
        metadata: options.metadata,
        signal: options.signal,
        now: options.now,
        onEvent: mergedOnEvent,
      });
      const steps: StepTrace[] = [];
      const toolTraces: ToolTrace[] = [];
      const messages: unknown[] = [];

      let originalInput: TInput;

      try {
        originalInput = state.inputSchema.parse(rawInput);
      } catch (error) {
        return {
          status: "failed",
          error: new ValidationError(`Invalid input for flow "${state.name}".`, {
            cause: error,
          }),
          steps,
          toolTraces,
          messages,
        };
      }

      await context.emit({
        type: "run.started",
        name: state.name,
        input: originalInput,
      });

      try {
        const results: Record<string, unknown> = {};
        let previous: unknown = undefined;

        for (const node of state.nodes) {
          const baseInput =
            previous === undefined
              ? originalInput
              : {
                  originalInput,
                  previous,
                  results,
                };

          await context.emit({
            type: "flow.node.started",
            flow: state.name,
            node: node.name,
            nodeType: node.kind,
            input: baseInput,
          });

          try {
            let value: unknown;

            if (node.kind === "agent") {
              const payload = previous === undefined ? originalInput : previous;
              const result = await node.agent.run(payload, {
                context: context.child({
                  metadata: {
                    flow: state.name,
                    node: node.name,
                    agent: node.agent.name,
                  },
                  onEvent: context.onEvent,
                }),
                memory: options.memory,
                threadId: options.threadId,
              });

              if (result.status !== "success") {
                throw result.error;
              }

              toolTraces.push(...result.toolTraces);
              messages.push(...result.messages);
              steps.push(...result.steps);
              value = result.output;
              steps.push({
                name: node.name,
                type: "flow",
                input: payload,
                output: value,
              });
            } else if (node.kind === "parallel") {
              const payload = previous === undefined ? originalInput : previous;
              const entries = Object.entries(node.agents);
              const runs = await Promise.all(
                entries.map(async ([key, agent]) => {
                  const result = await agent.run(payload, {
                    context: context.child({
                      metadata: {
                        flow: state.name,
                        node: node.name,
                        agent: agent.name,
                        parallelKey: key,
                      },
                      onEvent: context.onEvent,
                    }),
                    memory: options.memory,
                    threadId: options.threadId,
                  });

                  if (result.status !== "success") {
                    throw new FlowExecutionError(
                      `Parallel node "${node.name}" failed while running agent "${agent.name}".`,
                      { cause: result.error }
                    );
                  }

                  toolTraces.push(...result.toolTraces);
                  messages.push(...result.messages);
                  steps.push(...result.steps);

                  return [key, result.output] as const;
                })
              );

              value = Object.fromEntries(runs);
              steps.push({
                name: node.name,
                type: "parallel",
                input: payload,
                output: value,
              });
            } else {
              const parsedInput = node.process.inputSchema.parse({
                originalInput,
                previous,
                results,
              });
              const processContext = context.child({
                metadata: {
                  flow: state.name,
                  node: node.name,
                  process: node.process.name,
                },
              });
              const rawOutput = await node.process.run({
                input: parsedInput,
                ctx: processContext,
              });
              value = node.process.outputSchema.parse(rawOutput);
              steps.push({
                name: node.name,
                type: "process",
                input: parsedInput,
                output: value,
              });
            }

            results[node.name] = value;
            previous = value;

            await context.emit({
              type: "flow.node.completed",
              flow: state.name,
              node: node.name,
              nodeType: node.kind,
              output: value,
            });
          } catch (error) {
            const wrapped = new FlowExecutionError(
              `Flow "${state.name}" failed at node "${node.name}".`,
              { cause: error }
            );

            steps.push({
              name: node.name,
              type: node.kind === "parallel" ? "parallel" : node.kind === "process" ? "process" : "flow",
              input: baseInput,
              error: wrapped.message,
            });

            await context.emit({
              type: "flow.node.failed",
              flow: state.name,
              node: node.name,
              nodeType: node.kind,
              error: wrapped.message,
            });

            await context.emit({
              type: "run.completed",
              name: state.name,
              status: "failed",
            });

            return {
              status: "failed",
              error: wrapped,
              steps,
              toolTraces,
              messages,
            };
          }
        }

        const finalOutput = state.outputSchema.parse(
          await state.finalizeFn({
            originalInput,
            results: results as TResults,
          })
        );

        steps.push({
          name: "finalize",
          type: "flow",
          input: results,
          output: finalOutput,
        });

        await context.emit({
          type: "run.completed",
          name: state.name,
          status: "success",
        });

        return {
          status: "success",
          output: finalOutput,
          steps,
          toolTraces,
          messages,
        };
      } catch (error) {
        await context.emit({
          type: "run.completed",
          name: state.name,
          status: "failed",
        });

        return {
          status: "failed",
          error: error instanceof Error ? error : new Error(String(error)),
          steps,
          toolTraces,
          messages,
        };
      }
    },
  };
}

export interface CreateFlowOptions<
  TName extends string,
  TInputSchema extends SchemaLike,
  TOutputSchema extends SchemaLike,
> {
  name: TName;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  onFinalize?: (
    flow: Flow<InferSchema<TInputSchema>, InferSchema<TOutputSchema>, Record<string, unknown>, TName>
  ) => void;
}

export function createFlow<
  const TName extends string,
  TInputSchema extends SchemaLike,
  TOutputSchema extends SchemaLike,
>(
  options: CreateFlowOptions<TName, TInputSchema, TOutputSchema>
) : FlowBuilderApi<
    InferSchema<TInputSchema>,
    InferSchema<TOutputSchema>,
    {},
    InferSchema<TInputSchema>,
    TName
  > {
  return new FlowBuilder<
    InferSchema<TInputSchema>,
    InferSchema<TOutputSchema>,
    {},
    InferSchema<TInputSchema>,
    TName
  >({
    name: options.name,
    inputSchema: options.inputSchema as SchemaLike<InferSchema<TInputSchema>>,
    outputSchema: options.outputSchema as SchemaLike<InferSchema<TOutputSchema>>,
    nodes: [],
    onFinalize: options.onFinalize as FlowBuilderState<
      InferSchema<TInputSchema>,
      InferSchema<TOutputSchema>,
      {},
      InferSchema<TInputSchema>,
      TName
    >["onFinalize"],
  });
}
