import { createModelAdapter } from "../adapters/shared.js";
import type { ModelRequest, ModelResponse, RunContext } from "../core/types.js";

export interface FakeModelAdapter {
  name: string;
  generate<TOutput = unknown>(
    request: ModelRequest<TOutput>,
    context: RunContext
  ): Promise<ModelResponse<TOutput>>;
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
