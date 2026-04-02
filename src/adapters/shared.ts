import type { ModelAdapter, ModelRequest, ModelResponse, RunContext } from "../core/types.js";

export function createModelAdapter(config: {
  name: string;
  generate<TOutput = unknown>(
    request: ModelRequest<TOutput>,
    context: RunContext
  ): Promise<ModelResponse<TOutput>>;
}): ModelAdapter {
  return {
    name: config.name,
    generate: config.generate,
  };
}
