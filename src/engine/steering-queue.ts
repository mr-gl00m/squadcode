import {
  type ContextFragment,
  createContextFragment,
} from "../context/fragment.js";

export class SteeringQueue {
  private readonly pending: QueuedSteeringMessage[] = [];
  private nextId = 1;

  enqueue(content: string): number {
    const trimmed = content.trim();
    if (trimmed.length === 0) return this.pending.length;
    this.pending.push({ id: this.nextId++, content: trimmed });
    return this.pending.length;
  }

  get size(): number {
    return this.pending.length;
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  drain(): QueuedSteeringMessage[] {
    if (this.pending.length === 0) return [];
    return this.pending.splice(0, this.pending.length);
  }
}

export interface QueuedSteeringMessage {
  id: number;
  content: string;
}

export function steeringMessageFragment(
  message: QueuedSteeringMessage,
): ContextFragment {
  return createContextFragment({
    source: "repl",
    type: "steering",
    key: `queued-${message.id}`,
    role: "user",
    merge: "append",
    visibility: "model-and-user",
    trust: "untrusted-user",
    maxBytes: 16 * 1024,
    maxTokens: 4_096,
    content:
      "The user queued this steering message while the turn was active:\n" +
      message.content,
  });
}
