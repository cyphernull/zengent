import { z } from "zod";

import { createAsyncQueue } from "../core/async-queue.js";
import type { JsonSchema, ModelAdapter, ModelRequest, ModelResponse, ModelStream, RunContext } from "../core/types.js";

export function createModelAdapter(config: {
  name: string;
  generate<TOutput = unknown>(
    request: ModelRequest<TOutput>,
    context: RunContext
  ): Promise<ModelResponse<TOutput>>;
  streamGenerate?<TOutput = unknown>(
    request: ModelRequest<TOutput>,
    context: RunContext
  ): ModelStream<TOutput>;
}): ModelAdapter {
  return {
    name: config.name,
    generate: config.generate,
    streamGenerate: config.streamGenerate,
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

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function createTextModelStream<TOutput>(
  run: (emit: (chunk: string) => void) => Promise<ModelResponse<TOutput>>
): ModelStream<TOutput> {
  const queue = createAsyncQueue<string>();
  const textStream = queue.stream();

  const result = (async () => {
    try {
      const response = await run((chunk) => {
        if (chunk.length > 0) {
          queue.push(chunk);
        }
      });
      queue.finish();
      return response;
    } catch (error) {
      queue.fail(toError(error));
      throw error;
    }
  })();

  return {
    result,
    textStream,
    [Symbol.asyncIterator]() {
      return textStream[Symbol.asyncIterator]();
    },
  };
}

async function* readTextChunks(response: Response): AsyncIterable<string> {
  if (!response.body) {
    throw new Error("Streaming response body is missing.");
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    yield decoder.decode(value, { stream: true });
  }

  const trailing = decoder.decode();

  if (trailing.length > 0) {
    yield trailing;
  }
}

export interface SseEvent {
  event?: string;
  data: string;
}

export async function* readSseEvents(response: Response): AsyncIterable<SseEvent> {
  let buffer = "";

  for await (const chunk of readTextChunks(response)) {
    buffer += chunk;
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const rawEvent of events) {
      const lines = rawEvent
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);

      let event: string | undefined;
      const dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
      }

      const data = dataLines.join("");

      if (data.length > 0) {
        yield {
          event,
          data,
        };
      }
    }
  }

  if (buffer.trim().length > 0) {
    const lines = buffer
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);

    let event: string | undefined;
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }

    const data = dataLines.join("");

    if (data.length > 0) {
      yield {
        event,
        data,
      };
    }
  }
}

export async function* readJsonLines(response: Response): AsyncIterable<unknown> {
  let buffer = "";

  for await (const chunk of readTextChunks(response)) {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trim();

      if (line.length === 0) {
        continue;
      }

      yield JSON.parse(line);
    }
  }

  const trailing = buffer.trim();

  if (trailing.length > 0) {
    yield JSON.parse(trailing);
  }
}

export function streamGenerateFromGenerate<TOutput>(
  generate: (
    request: ModelRequest<TOutput>,
    context: RunContext
  ) => Promise<ModelResponse<TOutput>>,
  request: ModelRequest<TOutput>,
  context: RunContext
): ModelStream<TOutput> {
  return createTextModelStream(async (emit) => {
    const response = await generate(request, context);

    if (response.text) {
      emit(response.text);
    }

    return response;
  });
}

interface OpenAICompatibleStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export function createOpenAICompatibleStream<TOutput>(
  response: Response
): ModelStream<TOutput> {
  return createTextModelStream(async (emit) => {
    let text = "";
    let finishReason: ModelResponse["finishReason"];
    let usage: ModelResponse["usage"];
    const rawChunks: OpenAICompatibleStreamChunk[] = [];
    const toolCallsByIndex = new Map<
      number,
      {
        id: string;
        name: string;
        arguments: string;
      }
    >();

    const processEvent = (event: string) => {
      const data = event
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");

      if (!data || data === "[DONE]") {
        return;
      }

      const payload = JSON.parse(data) as OpenAICompatibleStreamChunk;
      rawChunks.push(payload);

      for (const choice of payload.choices ?? []) {
        const content = choice.delta?.content ?? undefined;

        if (content) {
          text += content;
          emit(content);
        }

        for (const toolCall of choice.delta?.tool_calls ?? []) {
          const index = toolCall.index ?? 0;
          const current = toolCallsByIndex.get(index) ?? {
            id: toolCall.id ?? `tool_${index + 1}`,
            name: toolCall.function?.name ?? "tool",
            arguments: "",
          };

          if (toolCall.id) {
            current.id = toolCall.id;
          }

          if (toolCall.function?.name) {
            current.name = toolCall.function.name;
          }

          if (toolCall.function?.arguments) {
            current.arguments += toolCall.function.arguments;
          }

          toolCallsByIndex.set(index, current);
        }

        if (choice.finish_reason === "tool_calls") {
          finishReason = "tool_calls";
        } else if (choice.finish_reason === "length") {
          finishReason = "length";
        } else if (choice.finish_reason === "stop") {
          finishReason = "stop";
        }
      }

      if (payload.usage) {
        usage = {
          inputTokens: payload.usage.prompt_tokens,
          outputTokens: payload.usage.completion_tokens,
          totalTokens: payload.usage.total_tokens,
        };
      }
    };

    for await (const event of readSseEvents(response)) {
      processEvent(`data: ${event.data}`);
    }

    return {
      text: text || undefined,
      toolCalls:
        toolCallsByIndex.size > 0
          ? Array.from(toolCallsByIndex.entries())
              .sort(([left], [right]) => left - right)
              .map(([, call]) => ({
                id: call.id,
                name: call.name,
                input: JSON.parse(call.arguments || "{}"),
              }))
          : undefined,
      finishReason: finishReason ?? "stop",
      usage,
      raw: rawChunks,
    };
  });
}

interface AnthropicStreamPayload {
  type:
    | "message_start"
    | "content_block_start"
    | "content_block_delta"
    | "content_block_stop"
    | "message_delta"
    | "message_stop"
    | string;
  index?: number;
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
  content_block?:
    | {
        type: "text";
        text?: string;
      }
    | {
        type: "tool_use";
        id: string;
        name: string;
        input?: unknown;
      };
  delta?:
    | {
        type: "text_delta";
        text?: string;
      }
    | {
        type: "input_json_delta";
        partial_json?: string;
      }
    | {
        stop_reason?: string | null;
      };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export function createAnthropicStream<TOutput>(
  response: Response
): ModelStream<TOutput> {
  return createTextModelStream(async (emit) => {
    let text = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let stopReason: string | undefined;
    const rawEvents: AnthropicStreamPayload[] = [];
    const toolCallsByIndex = new Map<
      number,
      {
        id: string;
        name: string;
        input?: unknown;
        partialJson: string;
      }
    >();

    for await (const event of readSseEvents(response)) {
      const payload = JSON.parse(event.data) as AnthropicStreamPayload;
      rawEvents.push(payload);

      if (payload.type === "message_start") {
        inputTokens = payload.message?.usage?.input_tokens;
        outputTokens = payload.message?.usage?.output_tokens ?? outputTokens;
        continue;
      }

      if (payload.type === "content_block_start") {
        const index = payload.index ?? 0;

        if (payload.content_block?.type === "text" && payload.content_block.text) {
          text += payload.content_block.text;
          emit(payload.content_block.text);
        }

        if (payload.content_block?.type === "tool_use") {
          toolCallsByIndex.set(index, {
            id: payload.content_block.id,
            name: payload.content_block.name,
            input: payload.content_block.input,
            partialJson: "",
          });
        }

        continue;
      }

      if (payload.type === "content_block_delta") {
        const index = payload.index ?? 0;
        const delta = payload.delta;

        if (
          delta &&
          "type" in delta &&
          delta.type === "text_delta" &&
          delta.text
        ) {
          text += delta.text;
          emit(delta.text);
        }

        if (
          delta &&
          "type" in delta &&
          delta.type === "input_json_delta"
        ) {
          const current = toolCallsByIndex.get(index);

          if (current) {
            current.partialJson += delta.partial_json ?? "";
          }
        }

        continue;
      }

      if (payload.type === "message_delta") {
        stopReason =
          payload.delta &&
          "stop_reason" in payload.delta &&
          typeof payload.delta.stop_reason === "string"
            ? payload.delta.stop_reason
            : stopReason;
        outputTokens = payload.usage?.output_tokens ?? outputTokens;
      }
    }

    const toolCalls =
      toolCallsByIndex.size > 0
        ? Array.from(toolCallsByIndex.entries())
            .sort(([left], [right]) => left - right)
            .map(([, call]) => ({
              id: call.id,
              name: call.name,
              input:
                call.partialJson.trim().length > 0
                  ? JSON.parse(call.partialJson)
                  : call.input ?? {},
            }))
        : undefined;

    return {
      text: text || undefined,
      toolCalls,
      finishReason:
        toolCalls && toolCalls.length > 0 || stopReason === "tool_use"
          ? "tool_calls"
          : stopReason === "max_tokens"
            ? "length"
            : "stop",
      usage:
        inputTokens !== undefined || outputTokens !== undefined
          ? {
              inputTokens,
              outputTokens,
              totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
            }
          : undefined,
      raw: rawEvents,
    };
  });
}

interface GeminiStreamChunk {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        functionCall?: {
          name?: string;
          args?: unknown;
          id?: string;
        };
      }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

export function createGeminiStream<TOutput>(
  response: Response
): ModelStream<TOutput> {
  return createTextModelStream(async (emit) => {
    let text = "";
    let finishReason: string | undefined;
    let usage: ModelResponse["usage"];
    const rawChunks: GeminiStreamChunk[] = [];
    const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];

    for await (const event of readSseEvents(response)) {
      const payload = JSON.parse(event.data) as GeminiStreamChunk;
      rawChunks.push(payload);

      const candidate = payload.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];

      for (const part of parts) {
        if (typeof part.text === "string" && part.text.length > 0) {
          text += part.text;
          emit(part.text);
        }

        if (part.functionCall?.name) {
          toolCalls.push({
            id: part.functionCall.id ?? `tool_${toolCalls.length + 1}`,
            name: part.functionCall.name,
            input: part.functionCall.args ?? {},
          });
        }
      }

      finishReason = candidate?.finishReason ?? finishReason;
      usage = payload.usageMetadata
        ? {
            inputTokens: payload.usageMetadata.promptTokenCount,
            outputTokens: payload.usageMetadata.candidatesTokenCount,
            totalTokens: payload.usageMetadata.totalTokenCount,
          }
        : usage;
    }

    return {
      text: text || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason:
        toolCalls.length > 0
          ? "tool_calls"
          : finishReason === "MAX_TOKENS"
            ? "length"
            : "stop",
      usage,
      raw: rawChunks,
    };
  });
}

interface OllamaStreamChunk {
  message?: {
    content?: string;
    tool_calls?: Array<{
      function?: {
        name?: string;
        arguments?: unknown;
      };
      name?: string;
      arguments?: unknown;
    }>;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export function createOllamaStream<TOutput>(
  response: Response
): ModelStream<TOutput> {
  return createTextModelStream(async (emit) => {
    let text = "";
    let finalChunk: OllamaStreamChunk | undefined;
    const rawChunks: OllamaStreamChunk[] = [];
    const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];

    for await (const value of readJsonLines(response)) {
      const payload = value as OllamaStreamChunk;
      rawChunks.push(payload);

      const content = payload.message?.content;

      if (content) {
        text += content;
        emit(content);
      }

      for (const call of payload.message?.tool_calls ?? []) {
        toolCalls.push({
          id: `tool_${toolCalls.length + 1}`,
          name: call.function?.name ?? call.name ?? "tool",
          input: call.function?.arguments ?? call.arguments ?? {},
        });
      }

      if (payload.done) {
        finalChunk = payload;
      }
    }

    return {
      text: text || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason:
        finalChunk?.done_reason === "length"
          ? "length"
          : toolCalls.length > 0
            ? "tool_calls"
            : "stop",
      usage:
        finalChunk?.prompt_eval_count !== undefined || finalChunk?.eval_count !== undefined
          ? {
              inputTokens: finalChunk?.prompt_eval_count,
              outputTokens: finalChunk?.eval_count,
              totalTokens:
                (finalChunk?.prompt_eval_count ?? 0) + (finalChunk?.eval_count ?? 0),
            }
          : undefined,
      raw: rawChunks,
    };
  });
}
