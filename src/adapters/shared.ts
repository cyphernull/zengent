import { z } from "zod";

import type { JsonSchema, ModelAdapter, ModelRequest, ModelResponse, RunContext } from "../core/types.js";

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

function toStructuredOutputJsonSchema<TOutput>(
  request: ModelRequest<TOutput>
): JsonSchema | undefined {
  if (!request.outputSchema) {
    return undefined;
  }

  return z.toJSONSchema(request.outputSchema as z.ZodTypeAny) as JsonSchema;
}

export function createOpenAICompatibleResponseFormat<TOutput>(
  request: ModelRequest<TOutput>
) {
  const schema = toStructuredOutputJsonSchema(request);

  if (!schema) {
    return undefined;
  }

  return {
    type: "json_schema" as const,
    json_schema: {
      name: "zengent_output",
      strict: true,
      schema,
    },
  };
}

export function createJsonModeResponseFormat<TOutput>(
  request: ModelRequest<TOutput>
) {
  if (!request.outputSchema) {
    return undefined;
  }

  return {
    type: "json_object" as const,
  };
}

export function createGeminiGenerationConfig<TOutput>(
  request: ModelRequest<TOutput>,
  options?: {
    maxOutputTokens?: number;
  }
) {
  const schema = toStructuredOutputJsonSchema(request);

  if (!schema && options?.maxOutputTokens === undefined) {
    return undefined;
  }

  return {
    ...(options?.maxOutputTokens !== undefined
      ? {
          maxOutputTokens: options.maxOutputTokens,
        }
      : {}),
    ...(schema
      ? {
          responseMimeType: "application/json",
          responseSchema: schema,
        }
      : {}),
  };
}

export function createOllamaFormat<TOutput>(request: ModelRequest<TOutput>) {
  return toStructuredOutputJsonSchema(request);
}

export function createStructuredOutputHint<TOutput>(
  request: ModelRequest<TOutput>
) {
  const schema = toStructuredOutputJsonSchema(request);

  if (!schema) {
    return undefined;
  }

  return [
    "Return only valid JSON that matches the required schema.",
    "Do not wrap the JSON in Markdown or code fences.",
    "Do not include any text before or after the JSON.",
    "Required JSON schema:",
    JSON.stringify(schema, null, 2),
  ].join("\n");
}

export function appendStructuredOutputHint<TOutput>(
  instructions: string | undefined,
  request: ModelRequest<TOutput>
) {
  const hint = createStructuredOutputHint(request);

  if (!hint) {
    return instructions;
  }

  return instructions ? `${instructions}\n\n${hint}` : hint;
}
