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

export function resolveApiKey(explicitApiKey: string | undefined, envVarName: string) {
  return explicitApiKey ?? process.env[envVarName];
}

export function requireApiKey(
  providerName: string,
  explicitApiKey: string | undefined,
  envVarName: string
) {
  const apiKey = resolveApiKey(explicitApiKey, envVarName);

  if (!apiKey) {
    throw new Error(
      `${providerName} adapter requires an API key. Pass apiKey explicitly or set ${envVarName}.`
    );
  }

  return apiKey;
}
