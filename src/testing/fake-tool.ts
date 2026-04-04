import { z } from "zod";

import { defineTool } from "../tool/define-tool.js";

export function createFakeTool<TOutput>(
  name: string,
  output: TOutput
) {
  return defineTool({
    name,
    description: `Fake tool ${name}`,
    inputSchema: z.object({ value: z.string().optional() }),
    outputSchema: z.any(),
    execute: async () => output,
  });
}
