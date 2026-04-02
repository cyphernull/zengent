import type { Message } from "../core/types.js";
import type { ThreadRecord } from "./thread.js";

export interface MemoryStore {
  getThread(threadId: string): Promise<ThreadRecord | undefined>;
  appendMessages(
    threadId: string,
    messages: Message[],
    metadata?: Record<string, unknown>
  ): Promise<void>;
}

class InMemoryStore implements MemoryStore {
  private readonly threads = new Map<string, ThreadRecord>();

  async getThread(threadId: string): Promise<ThreadRecord | undefined> {
    return this.threads.get(threadId);
  }

  async appendMessages(
    threadId: string,
    messages: Message[],
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const existing = this.threads.get(threadId);

    this.threads.set(threadId, {
      id: threadId,
      metadata: metadata ?? existing?.metadata,
      messages: [...(existing?.messages ?? []), ...messages],
    });
  }
}

export function createMemoryStore(): MemoryStore {
  return new InMemoryStore();
}
