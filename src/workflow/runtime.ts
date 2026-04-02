import { AsyncLocalStorage } from "node:async_hooks";

import type { EventHandler } from "../core/types.js";
import type { MemoryStore } from "../memory/memory-store.js";

export interface WorkflowRuntimeState {
  memory?: MemoryStore;
  threadId?: string;
  onEvent?: EventHandler;
}

const workflowRuntimeStorage = new AsyncLocalStorage<WorkflowRuntimeState>();

export function runWithWorkflowRuntime<TValue>(
  runtime: WorkflowRuntimeState,
  work: () => Promise<TValue>
): Promise<TValue> {
  return workflowRuntimeStorage.run(runtime, work);
}

export function getWorkflowRuntime(): WorkflowRuntimeState | undefined {
  return workflowRuntimeStorage.getStore();
}
