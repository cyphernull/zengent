import "dotenv/config";

import express from "express";
import { z } from "zod";
import { createZengent } from "../../../src/index.js";
import { deepseekAdapter } from "../../../src/adapters/deepseek.js";

const port = Number(process.env.PORT ?? 3001);
const runtime = createZengent();

const weatherFetch = runtime.tool({
  name: "weatherFetch",
  description: "Get a lightweight travel weather hint for a city.",
  inputSchema: z.object({
    city: z.string(),
  }),
  outputSchema: z.object({
    city: z.string(),
    forecast: z.string(),
    temperatureC: z.number(),
  }),
  execute: async ({ city }) => {
    const normalized = city.trim().toLowerCase();

    if (normalized.includes("tokyo")) {
      return { city, forecast: "clear", temperatureC: 22 };
    }

    if (normalized.includes("paris")) {
      return { city, forecast: "mild rain", temperatureC: 18 };
    }

    return { city, forecast: "partly cloudy", temperatureC: 20 };
  },
});

const travelAgent = runtime.agent({
  name: "travelPlanner",
  inputSchema: z.object({
    city: z.string(),
  }),
  outputSchema: z.object({
    itinerary: z.string(),
  }),
  instructions: `
You are a concise travel planner.

Use available tools when helpful.
The itinerary should be practical, brief, and friendly.
  `.trim(),
  prompt: ({ input }) =>
    [
      `Plan a one-day trip for ${input.city}.`,
      "Use the weather tool if it helps improve the itinerary.",
    ].join(" "),
  model: deepseekAdapter("deepseek-chat"),
  tools: [weatherFetch],
});

const server = express();
server.use(express.json());

server.get("/health", (_req, res) => {
  res.json({
    ok: true,
    demo: "travel-demo",
  });
});

server.post("/plan-trip", async (req, res) => {
  const result = await travelAgent.run(req.body);

  if (result.status !== "success") {
    res.status(400).json({
      status: result.status,
      error: result.error.message,
      toolTraces: result.toolTraces,
      steps: result.steps,
    });
    return;
  }

  res.json({
    status: result.status,
    output: result.output,
    toolTraces: result.toolTraces,
    steps: result.steps,
  });
});

server.post("/plan-trip/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const stream = travelAgent.stream(req.body);

  try {
    for await (const chunk of stream) {
      res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
    }

    const result = await stream.result;
    res.write(`event: result\ndata: ${JSON.stringify(result)}\n\n`);
  } catch (error) {
    res.write(
      `event: error\ndata: ${JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      })}\n\n`
    );
  } finally {
    res.end();
  }
});

server.listen(port, () => {
  console.log(`travel-demo listening on http://localhost:${port}`);
});
