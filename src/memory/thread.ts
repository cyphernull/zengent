import type { Message } from "../core/types.js";

export interface ThreadRecord {
  id: string;
  messages: Message[];
  metadata?: Record<string, unknown>;
}
