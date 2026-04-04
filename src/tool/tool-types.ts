import type { RunContext, ZodSchema, InferSchema } from "../core/types.js";

export interface ToolDefinition<
  TInputSchema extends ZodSchema = ZodSchema,
  TOutput = unknown,
  TName extends string = string,
> {
  readonly kind: "tool";
  readonly name: TName;
  readonly description: string;
  readonly inputSchema: TInputSchema;
  readonly outputSchema: ZodSchema<TOutput>;
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
