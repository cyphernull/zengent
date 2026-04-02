import type { RunContext, SchemaLike, InferSchema, JsonSchema } from "../core/types.js";

export interface ToolDefinition<
  TInputSchema extends SchemaLike = SchemaLike,
  TOutput = unknown,
  TName extends string = string,
> {
  readonly kind: "tool";
  readonly name: TName;
  readonly description: string;
  readonly input: TInputSchema;
  readonly inputSchema?: JsonSchema;
  readonly output?: SchemaLike<TOutput>;
  execute(
    input: InferSchema<TInputSchema>,
    context: RunContext
  ): Promise<TOutput> | TOutput;
  invoke(input: unknown, context: RunContext): Promise<TOutput>;
}

export type ToolInput<TTool> = TTool extends ToolDefinition<infer TInputSchema, any, any>
  ? InferSchema<TInputSchema>
  : never;

export type ToolOutput<TTool> = TTool extends ToolDefinition<any, infer TOutput, any>
  ? TOutput
  : never;
