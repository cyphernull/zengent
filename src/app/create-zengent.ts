import { randomUUID } from "node:crypto";

import { ConfigError } from "../core/errors.js";
import type { RunResult } from "../core/result.js";
import type { EventHandler, RunContextOptions } from "../core/types.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { ThreadRecord } from "../memory/thread.js";
import { createAgent, type Agent, type CreateAgentOptions } from "../agent/create-agent.js";
import { createFlow, type CreateFlowOptions, type Flow, type FlowRunOptions } from "../flow/create-flow.js";
import { defineTool, type DefineToolOptions } from "../tool/define-tool.js";
import type { ToolDefinition } from "../tool/tool-types.js";

export interface AppRunRecord<TResult = unknown> {
  runId: string;
  target: string;
  startedAt: string;
  completedAt: string;
  threadId?: string;
  result: TResult;
}

export interface ZengentRunOptions extends RunContextOptions {
  threadId?: string;
}

// App-level runtime only. A zengent app owns registries, memory, and flow execution.
export class ZengentApp {
  private memoryStore?: MemoryStore;
  private readonly eventHandlers: EventHandler[] = [];
  private readonly runs = new Map<string, AppRunRecord>();
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly agents = new Map<string, Agent>();
  private readonly flows = new Map<string, Flow>();

  memory(store: MemoryStore): this {
    this.memoryStore = store;
    return this;
  }

  onEvent(handler: EventHandler): this {
    this.eventHandlers.push(handler);
    return this;
  }

  tool<
    const TName extends string,
    TInputSchema extends import("../core/types.js").SchemaLike,
    TOutputSchema extends import("../core/types.js").SchemaLike,
  >(
    options: DefineToolOptions<TName, TInputSchema, TOutputSchema>
      | ToolDefinition<TInputSchema, import("../core/types.js").InferSchema<TOutputSchema>, TName>
  ) {
    const tool = "kind" in options ? options : defineTool(options);

    if (this.tools.has(tool.name)) {
      throw new ConfigError(`Duplicate tool named "${tool.name}".`);
    }

    this.tools.set(tool.name, tool);
    return tool;
  }

  agent<
    const TName extends string,
    TInputSchema extends import("../core/types.js").SchemaLike,
    TOutputSchema extends import("../core/types.js").SchemaLike,
    const TTools extends readonly ToolDefinition[] = readonly ToolDefinition[],
  >(
    options: CreateAgentOptions<TName, TInputSchema, TOutputSchema, TTools>
      | Agent<
          import("../core/types.js").InferSchema<TInputSchema>,
          import("../core/types.js").InferSchema<TOutputSchema>,
          TTools,
          TName
        >
  ) {
    const agent = "run" in options ? options : createAgent(options);

    if (this.agents.has(agent.name)) {
      throw new ConfigError(`Duplicate agent named "${agent.name}".`);
    }

    this.agents.set(agent.name, agent);
    return agent;
  }

  flow<
    const TName extends string,
    TInputSchema extends import("../core/types.js").SchemaLike,
    TOutputSchema extends import("../core/types.js").SchemaLike,
  >(options: CreateFlowOptions<TName, TInputSchema, TOutputSchema>) {
    return createFlow({
      ...options,
      onFinalize: (flow) => {
        if (this.flows.has(flow.name)) {
          throw new ConfigError(`Duplicate flow named "${flow.name}".`);
        }

        this.flows.set(flow.name, flow);
      },
    });
  }

  async runAgent<TInput, TOutput>(
    agentOrName: string | Agent<TInput, TOutput>,
    input: TInput,
    options: ZengentRunOptions = {}
  ): Promise<RunResult<TOutput>> {
    const agent =
      (typeof agentOrName === "string" ? this.agents.get(agentOrName) : agentOrName) as
        | Agent<TInput, TOutput>
        | undefined;

    if (!agent) {
      throw new ConfigError(`Unknown agent "${String(agentOrName)}".`);
    }

    const startedAt = new Date().toISOString();
    let runId: string | undefined;

    const result = await agent.run(input, {
      ...options,
      memory: this.memoryStore,
      onEvent: async (event) => {
        runId = runId ?? event.runId;
        for (const handler of this.eventHandlers) {
          await handler(event);
        }
        await options.onEvent?.(event);
      },
      metadata: {
        app: "zengent",
        ...options.metadata,
      },
    });

    const recordId = runId ?? randomUUID();

    this.runs.set(recordId, {
      runId: recordId,
      target: agent.name,
      startedAt,
      completedAt: new Date().toISOString(),
      threadId: options.threadId,
      result,
    });

    return result;
  }

  async runFlow<TInput, TOutput>(
    flowOrName: string | Flow<TInput, TOutput>,
    input: TInput,
    options: FlowRunOptions = {}
  ): Promise<RunResult<TOutput>> {
    const flow =
      (typeof flowOrName === "string" ? this.flows.get(flowOrName) : flowOrName) as
        | Flow<TInput, TOutput>
        | undefined;

    if (!flow) {
      throw new ConfigError(`Unknown flow "${String(flowOrName)}".`);
    }

    const startedAt = new Date().toISOString();
    let runId: string | undefined;

    const result = await flow.run(input, {
      ...options,
      memory: this.memoryStore,
      onEvent: async (event) => {
        runId = runId ?? event.runId;
        for (const handler of this.eventHandlers) {
          await handler(event);
        }
        await options.onEvent?.(event);
      },
      metadata: {
        app: "zengent",
        ...options.metadata,
      },
    });

    const recordId = runId ?? randomUUID();

    this.runs.set(recordId, {
      runId: recordId,
      target: flow.name,
      startedAt,
      completedAt: new Date().toISOString(),
      threadId: options.threadId,
      result,
    });

    return result;
  }

  async getThread(threadId: string): Promise<ThreadRecord | undefined> {
    if (!this.memoryStore) {
      return undefined;
    }

    return this.memoryStore.getThread(threadId);
  }

  getRun(runId: string): AppRunRecord | undefined {
    return this.runs.get(runId);
  }
}

export function createZengent() {
  return new ZengentApp();
}
