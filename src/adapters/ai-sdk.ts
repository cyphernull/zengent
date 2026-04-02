import { createModelAdapter } from "./shared.js";
import type { Message, ModelAdapter, ModelRequest, ToolDescriptor, Usage } from "../core/types.js";

export interface AISDKToolCall {
  toolName: string;
  args: unknown;
  toolCallId?: string;
}

export interface AISDKGenerateResult<TOutput = unknown> {
  text?: string;
  output?: TOutput;
  toolCalls?: AISDKToolCall[];
  finishReason?: "stop" | "tool_calls" | "length" | "error";
  usage?: Usage;
  raw?: unknown;
}

export interface AISDKLikeModel {
  generate<TOutput = unknown>(request: {
    instructions?: string;
    messages: Message[];
    tools?: ToolDescriptor[];
    outputSchema?: { parse(value: unknown): TOutput };
    signal?: AbortSignal;
    metadata?: Record<string, unknown>;
  }): Promise<AISDKGenerateResult<TOutput>>;
}

export function aiSdkAdapter(
  model: AISDKLikeModel,
  options?: {
    name?: string;
  }
): ModelAdapter {
  return createModelAdapter({
    name: options?.name ?? "ai-sdk",
    async generate<TOutput>(request: ModelRequest<TOutput>) {
      const result = await model.generate(request);

      return {
        text: result.text,
        output: result.output as TOutput | undefined,
        toolCalls: result.toolCalls?.map((call, index) => ({
          id: call.toolCallId ?? `tool_${index + 1}`,
          name: call.toolName,
          input: call.args,
        })),
        finishReason: result.finishReason,
        usage: result.usage,
        raw: result.raw,
      };
    },
  });
}
