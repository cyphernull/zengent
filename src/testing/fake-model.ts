import { createModelAdapter, createTextModelStream } from "../adapters/shared.js";
import type { ModelRequest, ModelResponse, RunContext } from "../core/types.js";

export interface FakeModelAdapter {
  name: string;
  generate<TOutput = unknown>(
    request: ModelRequest<TOutput>,
    context: RunContext
  ): Promise<ModelResponse<TOutput>>;
  streamGenerate?<TOutput = unknown>(
    request: ModelRequest<TOutput>,
    context: RunContext
  ): import("../core/types.js").ModelStream<TOutput>;
  calls: Array<ModelRequest>;
}

type FakeReply =
  | ModelResponse
  | ((
      request: ModelRequest,
      context: RunContext
    ) => ModelResponse | Promise<ModelResponse>);

export function createFakeModel(replies: FakeReply[] = []): FakeModelAdapter {
  const queue = [...replies];
  const calls: Array<ModelRequest> = [];

  const adapter = createModelAdapter({
    name: "fake-model",
    async generate<TOutput>(
      request: ModelRequest<TOutput>,
      context: RunContext
    ) {
      calls.push(request);
      const reply = queue.shift();

      if (!reply) {
        return {
          text: "ok",
          finishReason: "stop",
        } as ModelResponse<TOutput>;
      }

      return (typeof reply === "function" ? reply(request, context) : reply) as ModelResponse<TOutput>;
    },
  }) as FakeModelAdapter;

  adapter.calls = calls;

  return adapter;
}

type FakeStreamingReply =
  | {
      chunks: string[];
      response?: ModelResponse;
    }
  | ((
      request: ModelRequest,
      context: RunContext
    ) => {
      chunks: string[];
      response?: ModelResponse;
    } | Promise<{
      chunks: string[];
      response?: ModelResponse;
    }>);

export function createFakeStreamingModel(
  replies: FakeStreamingReply[] = []
): FakeModelAdapter {
  const queue = [...replies];
  const calls: Array<ModelRequest> = [];

  const generate = async <TOutput>(
    request: ModelRequest<TOutput>,
    context: RunContext
  ) => {
    calls.push(request);
    const reply = queue.shift();

    if (!reply) {
      return {
        text: "ok",
        finishReason: "stop",
      } as ModelResponse<TOutput>;
    }

    const resolved =
      typeof reply === "function" ? await reply(request, context) : reply;
    const text = resolved.chunks.join("");

    return {
      text,
      finishReason: "stop",
      ...(resolved.response ?? {}),
    } as ModelResponse<TOutput>;
  };

  const adapter = createModelAdapter({
    name: "fake-streaming-model",
    generate,
    streamGenerate<TOutput>(
      request: ModelRequest<TOutput>,
      context: RunContext
    ) {
      calls.push(request);
      const reply = queue.shift();

      return createTextModelStream(async (emit) => {
        const resolved =
          !reply
            ? { chunks: ["ok"] }
            : typeof reply === "function"
              ? await reply(request, context)
              : reply;

        for (const chunk of resolved.chunks) {
          emit(chunk);
        }

        return {
          text: resolved.chunks.join(""),
          finishReason: "stop",
          ...(resolved.response ?? {}),
        } as ModelResponse<TOutput>;
      });
    },
  }) as FakeModelAdapter;

  adapter.calls = calls;

  return adapter;
}
