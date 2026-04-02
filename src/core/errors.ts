export class ZenGentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends ZenGentError {}
export class ConfigError extends ZenGentError {}
export class AgentExecutionError extends ZenGentError {}
export class ToolExecutionError extends ZenGentError {}
export class WorkflowExecutionError extends ZenGentError {}
export class TimeoutError extends ZenGentError {}
