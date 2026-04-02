import { randomUUID } from "node:crypto";

import { ConfigError } from "../core/errors.js";
import type { RunResult } from "../core/result.js";
import type { EventHandler, RunContextOptions } from "../core/types.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { ThreadRecord } from "../memory/thread.js";
import type { MainWorkflow } from "../workflow/create-main-workflow.js";

type AnyMainWorkflow = MainWorkflow<any, any, any, any>;

type WorkflowInput<TWorkflow> = TWorkflow extends MainWorkflow<infer TInput, any, any, any>
  ? TInput
  : never;

type WorkflowOutput<TWorkflow> = TWorkflow extends MainWorkflow<
  any,
  infer TOutput,
  any,
  any,
  infer TPaused
>
  ? RunResult<TOutput, TPaused>
  : never;

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

// App-level runtime only. A ZenGent app owns global state and executes one main workflow.
export class ZengentApp<TMainWorkflow extends AnyMainWorkflow | undefined = undefined> {
  private memoryStore?: MemoryStore;
  private readonly eventHandlers: EventHandler[] = [];
  private readonly runs = new Map<string, AppRunRecord>();
  private currentMainWorkflow?: AnyMainWorkflow;

  memory(store: MemoryStore): this {
    this.memoryStore = store;
    return this;
  }

  onEvent(handler: EventHandler): this {
    this.eventHandlers.push(handler);
    return this;
  }

  mainWorkflow<TWorkflow extends AnyMainWorkflow>(
    workflow: TWorkflow
  ): ZengentApp<TWorkflow> {
    this.currentMainWorkflow = workflow;
    return this as unknown as ZengentApp<TWorkflow>;
  }

  async run(
    input: WorkflowInput<TMainWorkflow>,
    options: ZengentRunOptions = {}
  ): Promise<WorkflowOutput<TMainWorkflow>> {
    if (!this.currentMainWorkflow) {
      throw new ConfigError("A mainWorkflow must be configured before app.run() can be used.");
    }

    const startedAt = new Date().toISOString();
    let runId: string | undefined;

    const result = await this.currentMainWorkflow.run(input, {
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
      target: this.currentMainWorkflow.name,
      startedAt,
      completedAt: new Date().toISOString(),
      threadId: options.threadId,
      result,
    });

    return result as WorkflowOutput<TMainWorkflow>;
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
