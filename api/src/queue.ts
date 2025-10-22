import { Queue, Worker } from 'bullmq';

/** Job queue seam: BullMQ on Redis in production, in-process for tests and local dev. */
export interface JobQueue {
  add(itemId: string, opts?: { delayMs?: number; priority?: number }): Promise<void>;
  process(handler: (itemId: string, attempt: number) => Promise<void>): void;
  drain?(): Promise<void>;
}

export class BullQueue implements JobQueue {
  private q: Queue;
  constructor(private connection: { host: string; port: number }, private name = 'contentloom-generate') {
    this.q = new Queue(name, { connection });
  }

  async add(itemId: string, opts: { delayMs?: number; priority?: number } = {}) {
    // jobId = itemId: re-enqueueing an item that's already waiting is a no-op (no duplicate generations).
    await this.q.add('generate', { itemId }, {
      jobId: itemId, delay: opts.delayMs, priority: opts.priority,
      attempts: 4, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 1000, removeOnFail: 5000,
    });
  }

  process(handler: (itemId: string, attempt: number) => Promise<void>) {
    // Concurrency + a global rate limit keep us under the model API's rate limits across all workers.
    new Worker(this.name, async (job) => handler(job.data.itemId, job.attemptsMade + 1), {
      connection: this.connection, concurrency: 8, limiter: { max: 50, duration: 60_000 },
    });
  }
}

export class MemoryQueue implements JobQueue {
  private pending: string[] = [];
  private handler?: (itemId: string, attempt: number) => Promise<void>;
  private attempts = new Map<string, number>();
  readonly maxAttempts = 4;

  async add(itemId: string) {
    if (!this.pending.includes(itemId)) this.pending.push(itemId);
  }

  process(handler: (itemId: string, attempt: number) => Promise<void>) {
    this.handler = handler;
  }

  /** Run until the queue is empty (tests). Retries failed jobs like BullMQ's `attempts`. */
  async drain() {
    while (this.pending.length) {
      const id = this.pending.shift()!;
      const attempt = (this.attempts.get(id) ?? 0) + 1;
      this.attempts.set(id, attempt);
      try {
        await this.handler!(id, attempt);
      } catch {
        if (attempt < this.maxAttempts) this.pending.push(id);
      }
    }
  }
}
