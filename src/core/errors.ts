export class ZengentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends ZengentError {}
export class ConfigError extends ZengentError {}
export class AgentExecutionError extends ZengentError {}
export class ToolExecutionError extends ZengentError {}
export class FlowExecutionError extends ZengentError {}
export class WorkflowExecutionError extends FlowExecutionError {}
export class TimeoutError extends ZengentError {}
