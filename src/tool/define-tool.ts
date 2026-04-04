import type { ZodType } from "zod";

import { ValidationError } from "../core/errors.js";
import type { InferSchema, RunContext, ZodSchema } from "../core/types.js";
import type { ToolDefinition } from "./tool-types.js";

export interface DefineToolOptions<
  TName extends string,
  TInputSchema extends ZodType,
  TOutputSchema extends ZodType,
> {
  name: TName;
  description: string;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  execute(
    input: InferSchema<TInputSchema>,
    context: RunContext
  ): Promise<InferSchema<TOutputSchema>>
    | InferSchema<TOutputSchema>;
}

export function defineTool<
  const TName extends string,
  TInputSchema extends ZodType,
  TOutputSchema extends ZodType,
>(
  options: DefineToolOptions<TName, TInputSchema, TOutputSchema>
): ToolDefinition<TInputSchema, InferSchema<TOutputSchema>, TName> {
  // Tools are external capability units. They do not own model execution.
  return {
    kind: "tool",
    name: options.name,
    description: options.description,
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema as ZodSchema<InferSchema<TOutputSchema>>,
    execute: options.execute,
    async invoke(rawInput, context) {
      let parsedInput: InferSchema<TInputSchema>;

      try {
        parsedInput = options.inputSchema.parse(rawInput) as InferSchema<TInputSchema>;
      } catch (error) {
        throw new ValidationError(`Invalid input for tool "${options.name}"`, {
          cause: error,
        });
      }

      const value = await options.execute(parsedInput, context);

      try {
        return options.outputSchema.parse(value) as InferSchema<TOutputSchema>;
      } catch (error) {
        throw new ValidationError(`Invalid output for tool "${options.name}"`, {
          cause: error,
        });
      }
    },
  };
}
