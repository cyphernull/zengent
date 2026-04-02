import { createRunContext } from "../core/context.js";
import { ConfigError, ValidationError, WorkflowExecutionError } from "../core/errors.js";
import type { RunResult, StepTrace, ToolTrace } from "../core/result.js";
import type { EventHandler, InferSchema, RunContext, RunContextOptions, SchemaLike } from "../core/types.js";
import type {
  Agent,
  AgentInput,
  AgentOutput,
  AgentRunOptions,
} from "../agent/create-agent.js";
import type { RunStream } from "../core/result.js";
import type { ToolDefinition } from "../tool/tool-types.js";
import type { MemoryStore } from "../memory/memory-store.js";
import { branch as runBranch, parallel as runParallel } from "./control-flow.js";
import { isPauseSignal, type PauseSignal } from "./step.js";
import { getWorkflowRuntime, runWithWorkflowRuntime } from "./runtime.js";

type AnyTool = ToolDefinition<any, any, string>;
type AnyAgent = Agent<any, readonly ToolDefinition[], string>;

type NamedTools<TTools extends readonly AnyTool[]> = {
  [TTool in TTools[number] as TTool["name"]]: TTool;
};

type BoundAgent<TAgent extends AnyAgent> = {
  readonly name: TAgent["name"];
  readonly instructions?: TAgent["instructions"];
  readonly model: TAgent["model"];
  readonly tools: TAgent["tools"];
  run(
    input: AgentInput,
    options?: AgentRunOptions
  ): Promise<RunResult<AgentOutput<TAgent>>>;
  stream(input: AgentInput, options?: AgentRunOptions): RunStream<AgentOutput<TAgent>>;
};

type NamedAgents<TAgents extends readonly AnyAgent[]> = {
  [TAgent in TAgents[number] as TAgent["name"]]: BoundAgent<TAgent>;
};

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

function assertUniqueNames<TResource extends { name: string }>(
  kind: string,
  resources: readonly TResource[]
): void {
  const seen = new Set<string>();

  for (const resource of resources) {
    if (seen.has(resource.name)) {
      throw new ConfigError(`Duplicate ${kind} named "${resource.name}".`);
    }

    seen.add(resource.name);
  }
}

function toToolNamespace<TTools extends readonly AnyTool[]>(
  tools: TTools
): NamedTools<TTools> {
  assertUniqueNames("tool", tools);
  const namespace = {} as NamedTools<TTools>;

  for (const tool of tools) {
    (namespace as Record<string, AnyTool>)[tool.name] = tool;
  }

  return namespace;
}

function toAgentNamespace<TAgents extends readonly AnyAgent[]>(
  agents: TAgents,
  context: RunContext,
  runtime: {
    memory?: MemoryStore;
    threadId?: string;
  }
): NamedAgents<TAgents> {
  assertUniqueNames("agent", agents);
  const namespace = {} as NamedAgents<TAgents>;

  for (const agent of agents) {
    (namespace as Record<string, BoundAgent<AnyAgent>>)[agent.name] = {
      name: agent.name,
      instructions: agent.instructions,
      model: agent.model,
      tools: agent.tools,
      run(input, options) {
        return agent.run(input, {
          ...options,
          context:
            options?.context ??
            context.child({
              metadata: {
                workflow: context.metadata.workflow,
                agent: agent.name,
                ...options?.metadata,
              },
              signal: options?.signal,
              onEvent: mergeEventHandlers(context.onEvent, options?.onEvent),
            }),
          memory: options?.memory ?? runtime.memory,
          threadId: options?.threadId ?? runtime.threadId,
        });
      },
      stream(input, options) {
        return agent.stream(input, {
          ...options,
          context:
            options?.context ??
            context.child({
              metadata: {
                workflow: context.metadata.workflow,
                agent: agent.name,
                ...options?.metadata,
              },
              signal: options?.signal,
              onEvent: mergeEventHandlers(context.onEvent, options?.onEvent),
            }),
          memory: options?.memory ?? runtime.memory,
          threadId: options?.threadId ?? runtime.threadId,
        });
      },
    };
  }

  return namespace;
}

interface WorkflowRuntimeOptions extends RunContextOptions {
  memory?: MemoryStore;
  threadId?: string;
}

export interface MainWorkflowStepContext<
  TInput,
  TSteps,
  TTools extends readonly AnyTool[],
  TAgents extends readonly AnyAgent[],
> {
  input: TInput;
  steps: Readonly<TSteps>;
  state: Readonly<TSteps>;
  ctx: RunContext;
  tools: NamedTools<TTools>;
  agents: NamedAgents<TAgents>;
  parallel: typeof runParallel;
  branch: typeof runBranch;
}

export type MainWorkflowStepHandler<
  TInput,
  TSteps,
  TTools extends readonly AnyTool[],
  TAgents extends readonly AnyAgent[],
  TOutput,
> = (
  context: MainWorkflowStepContext<TInput, TSteps, TTools, TAgents>
) => Promise<TOutput> | TOutput;

interface StepRecord<
  TInput,
  TSteps,
  TTools extends readonly AnyTool[],
  TAgents extends readonly AnyAgent[],
> {
  name: string;
  run(
    context: MainWorkflowStepContext<TInput, TSteps, TTools, TAgents>
  ): Promise<unknown>;
}

type PauseState<TSteps extends Record<string, unknown>> = {
  steps: Partial<TSteps>;
  lastStep?: keyof TSteps;
  value?: unknown;
};

export interface WorkflowWithResources<
  TInput,
  TSteps extends Record<string, unknown>,
  TTools extends readonly AnyTool[],
  TAgents extends readonly AnyAgent[],
  TPausedState = PauseState<TSteps>,
> {
  readonly name: string;
  readonly tools: NamedTools<TTools>;
  readonly agents: NamedAgents<TAgents>;
  commit(): WorkflowWithResources<TInput, TSteps, TTools, TAgents, TPausedState>;
  run(
    input: unknown,
    options?: WorkflowRuntimeOptions
  ): Promise<RunResult<TSteps, TPausedState>>;
}

export interface SubWorkflow<
  TInput,
  TSteps extends Record<string, unknown>,
  TTools extends readonly AnyTool[],
  TAgents extends readonly AnyAgent[],
  TPausedState = PauseState<TSteps>,
> extends WorkflowWithResources<TInput, TSteps, TTools, TAgents, TPausedState> {
  // Internal workflow owned by a main workflow.
  commit(): SubWorkflow<TInput, TSteps, TTools, TAgents, TPausedState>;
  step<const TName extends string, TOutput>(
    name: TName,
    handler: MainWorkflowStepHandler<TInput, TSteps, TTools, TAgents, TOutput>
  ): SubWorkflow<TInput, TSteps & Record<TName, TOutput>, TTools, TAgents>;
}

export interface MainWorkflow<
  TInput,
  TSteps extends Record<string, unknown>,
  TTools extends readonly AnyTool[],
  TAgents extends readonly AnyAgent[],
  TPausedState = PauseState<TSteps>,
> extends WorkflowWithResources<TInput, TSteps, TTools, TAgents, TPausedState> {
  // Sole top-level workflow for a ZenGent app.
  commit(): MainWorkflow<TInput, TSteps, TTools, TAgents, TPausedState>;
  step<const TName extends string, TOutput>(
    name: TName,
    handler: MainWorkflowStepHandler<TInput, TSteps, TTools, TAgents, TOutput>
  ): MainWorkflow<TInput, TSteps & Record<TName, TOutput>, TTools, TAgents>;
  createSubWorkflow<TInputSchema extends SchemaLike>(options: {
    name: string;
    input: TInputSchema;
  }): SubWorkflow<InferSchema<TInputSchema>, {}, TTools, TAgents>;
}

class ResourceWorkflowDefinition<
  TInput,
  TSteps extends Record<string, unknown>,
  TTools extends readonly AnyTool[],
  TAgents extends readonly AnyAgent[],
> implements WorkflowWithResources<TInput, TSteps, TTools, TAgents>
{
  protected readonly stepRecords: StepRecord<TInput, any, TTools, TAgents>[] = [];
  protected committed = false;

  constructor(
    public readonly name: string,
    protected readonly inputSchema: SchemaLike<TInput>,
    public readonly tools: NamedTools<TTools>,
    public readonly agents: NamedAgents<TAgents>
  ) {}

  protected appendStep<const TName extends string, TOutput>(
    name: TName,
    handler: MainWorkflowStepHandler<TInput, TSteps, TTools, TAgents, TOutput>
  ): void {
    this.stepRecords.push({
      name,
      async run(context) {
        return handler(context as MainWorkflowStepContext<TInput, TSteps, TTools, TAgents>);
      },
    });
  }

  commit(): WorkflowWithResources<TInput, TSteps, TTools, TAgents> {
    this.committed = true;
    return this;
  }

  async run(
    rawInput: unknown,
    options: WorkflowRuntimeOptions = {}
  ): Promise<RunResult<TSteps, PauseState<TSteps>>> {
    if (!this.committed) {
      throw new ConfigError(`Workflow "${this.name}" must be committed before it can run.`);
    }

    const inheritedRuntime = getWorkflowRuntime();
    const mergedOnEvent = mergeEventHandlers(inheritedRuntime?.onEvent, options.onEvent);
    const context = createRunContext({
      runId: options.runId,
      metadata: options.metadata,
      signal: options.signal,
      now: options.now,
      onEvent: mergedOnEvent,
    });
    const steps = [] as StepTrace[];
    const toolTraces = [] as ToolTrace[];
    const outputs: Record<string, unknown> = {};
    const runtime = {
      memory: options.memory ?? inheritedRuntime?.memory,
      threadId: options.threadId ?? inheritedRuntime?.threadId,
    };
    let input: TInput;

    try {
      input = this.inputSchema.parse(rawInput);
    } catch (error) {
      return {
        status: "failed",
        error: new ValidationError(`Invalid input for workflow "${this.name}".`, {
          cause: error,
        }),
        steps,
        toolTraces,
        messages: [],
      };
    }

    await context.emit({
      type: "run.started",
      name: this.name,
      input,
    });

    return runWithWorkflowRuntime(
      {
        memory: runtime.memory,
        threadId: runtime.threadId,
        onEvent: mergedOnEvent,
      },
      async () => {
        for (const stepRecord of this.stepRecords) {
          await context.emit({
            type: "workflow.step.started",
            workflow: this.name,
            step: stepRecord.name,
            input,
          });

          try {
            const value = await stepRecord.run({
              input,
              steps: outputs as TSteps,
              state: outputs as TSteps,
              ctx: context.child({
                metadata: {
                  workflow: this.name,
                  step: stepRecord.name,
                },
              }),
              tools: this.tools,
              agents: toAgentNamespace(
                Object.values(this.agents).map((agent) => agent as AnyAgent) as unknown as TAgents,
                context,
                runtime
              ),
              parallel: runParallel,
              branch: runBranch,
            });

            if (isPauseSignal(value)) {
              const pauseValue = value as PauseSignal;
              const paused = {
                status: "paused" as const,
                state: {
                  steps: outputs as Partial<TSteps>,
                  lastStep: stepRecord.name as keyof TSteps,
                  value: pauseValue.state,
                },
                reason: pauseValue.reason,
                steps,
                toolTraces,
                messages: [],
              };

              await context.emit({
                type: "run.completed",
                name: this.name,
                status: paused.status,
              });

              return paused;
            }

            outputs[stepRecord.name] = value;
            steps.push({
              name: stepRecord.name,
              type: "workflow",
              input,
              output: value,
            });

            await context.emit({
              type: "workflow.step.completed",
              workflow: this.name,
              step: stepRecord.name,
              output: value,
            });
          } catch (error) {
            const wrapped = new WorkflowExecutionError(
              `Workflow "${this.name}" failed at step "${stepRecord.name}".`,
              { cause: error }
            );

            steps.push({
              name: stepRecord.name,
              type: "workflow",
              input,
              error: wrapped.message,
            });

            await context.emit({
              type: "workflow.step.failed",
              workflow: this.name,
              step: stepRecord.name,
              error: wrapped.message,
            });

            const failed = {
              status: "failed" as const,
              error: wrapped,
              steps,
              toolTraces,
              messages: [],
            };

            await context.emit({
              type: "run.completed",
              name: this.name,
              status: failed.status,
            });

            return failed;
          }
        }

        const result = {
          status: "success" as const,
          output: outputs as TSteps,
          steps,
          toolTraces,
          messages: [],
        };

        await context.emit({
          type: "run.completed",
          name: this.name,
          status: result.status,
        });

        return result;
      }
    );
  }
}

class SubWorkflowDefinition<
  TInput,
  TSteps extends Record<string, unknown>,
  TTools extends readonly AnyTool[],
  TAgents extends readonly AnyAgent[],
> extends ResourceWorkflowDefinition<TInput, TSteps, TTools, TAgents>
implements SubWorkflow<TInput, TSteps, TTools, TAgents>
{
  override commit(): SubWorkflow<TInput, TSteps, TTools, TAgents> {
    super.commit();
    return this;
  }

  step<const TName extends string, TOutput>(
    name: TName,
    handler: MainWorkflowStepHandler<TInput, TSteps, TTools, TAgents, TOutput>
  ): SubWorkflow<TInput, TSteps & Record<TName, TOutput>, TTools, TAgents> {
    this.appendStep(name, handler);
    return this as unknown as SubWorkflow<
      TInput,
      TSteps & Record<TName, TOutput>,
      TTools,
      TAgents
    >;
  }
}

class MainWorkflowDefinition<
  TInput,
  TSteps extends Record<string, unknown>,
  TTools extends readonly AnyTool[],
  TAgents extends readonly AnyAgent[],
> extends ResourceWorkflowDefinition<TInput, TSteps, TTools, TAgents>
implements MainWorkflow<TInput, TSteps, TTools, TAgents>
{
  private readonly subWorkflows = new Map<string, SubWorkflow<any, any, TTools, TAgents>>();

  override commit(): MainWorkflow<TInput, TSteps, TTools, TAgents> {
    super.commit();
    return this;
  }

  step<const TName extends string, TOutput>(
    name: TName,
    handler: MainWorkflowStepHandler<TInput, TSteps, TTools, TAgents, TOutput>
  ): MainWorkflow<TInput, TSteps & Record<TName, TOutput>, TTools, TAgents> {
    this.appendStep(name, handler);
    return this as unknown as MainWorkflow<
      TInput,
      TSteps & Record<TName, TOutput>,
      TTools,
      TAgents
    >;
  }

  createSubWorkflow<TInputSchema extends SchemaLike>(options: {
    name: string;
    input: TInputSchema;
  }): SubWorkflow<InferSchema<TInputSchema>, {}, TTools, TAgents> {
    if (this.subWorkflows.has(options.name)) {
      throw new ConfigError(`Duplicate subWorkflow named "${options.name}".`);
    }

    const subWorkflow = new SubWorkflowDefinition<
      InferSchema<TInputSchema>,
      {},
      TTools,
      TAgents
    >(
      options.name,
      options.input as SchemaLike<InferSchema<TInputSchema>>,
      this.tools,
      this.agents
    );

    this.subWorkflows.set(options.name, subWorkflow);

    return subWorkflow;
  }
}

export function createMainWorkflow<
  TInputSchema extends SchemaLike,
  const TTools extends readonly AnyTool[] = [],
  const TAgents extends readonly AnyAgent[] = [],
>(options: {
  name: string;
  input: TInputSchema;
  tools?: TTools;
  agents?: TAgents;
}): MainWorkflow<InferSchema<TInputSchema>, {}, TTools, TAgents> {
  const tools = (options.tools ?? []) as TTools;
  const agents = (options.agents ?? []) as TAgents;
  const toolNamespace = toToolNamespace(tools);
  const agentNamespace = toAgentNamespace(
    agents,
    createRunContext({
      metadata: {
        workflow: options.name,
      },
    }),
    {}
  );

  return new MainWorkflowDefinition<
    InferSchema<TInputSchema>,
    {},
    TTools,
    TAgents
  >(
    options.name,
    options.input as SchemaLike<InferSchema<TInputSchema>>,
    toolNamespace,
    agentNamespace
  ) as MainWorkflow<InferSchema<TInputSchema>, {}, TTools, TAgents>;
}
