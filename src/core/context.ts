import { randomUUID } from "node:crypto";

import type { RunContext, RunContextOptions, RunEvent } from "./types.js";

export function createRunContext(options: RunContextOptions = {}): RunContext {
  const runId = options.runId ?? randomUUID();
  const now = options.now ?? (() => new Date());
  let counter = 0;

  const context: RunContext = {
    runId,
    signal: options.signal,
    metadata: options.metadata ?? {},
    now,
    onEvent: options.onEvent,
    async emit(event) {
      if (!context.onEvent) {
        return;
      }

      const payload: RunEvent = {
        ...event,
        runId,
        timestamp: now().toISOString(),
      } as RunEvent;

      await context.onEvent(payload);
    },
    child(overrides = {}) {
      return createRunContext({
        runId,
        now,
        signal: overrides.signal ?? context.signal,
        metadata: {
          ...context.metadata,
          ...overrides.metadata,
        },
        onEvent: overrides.onEvent ?? context.onEvent,
      });
    },
    nextId(prefix = "evt") {
      counter += 1;
      return `${prefix}_${counter}`;
    },
  };

  return context;
}
