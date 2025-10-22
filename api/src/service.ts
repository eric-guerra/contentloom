import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Brief, Item, route, RoutingPolicy, transition } from './domain';
import { generate, score } from './llm';
import type { JobQueue } from './queue';

export const LLM_CLIENT = Symbol('LLM_CLIENT');
export const JOB_QUEUE = Symbol('JOB_QUEUE');
export const POLICY = Symbol('POLICY');
export const RANDOM = Symbol('RANDOM');

/** Items live in Postgres in production; a Map keeps the service logic testable without one. */
@Injectable()
export class ContentService {
  readonly items = new Map<string, Item>();

  constructor(
    @Inject(LLM_CLIENT) private readonly client: any,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    @Inject(POLICY) private readonly policy: RoutingPolicy,
    @Inject(RANDOM) private readonly rand: () => number,
  ) {
    queue.process((id, attempt) => this.work(id, attempt));
  }

  async createBatch(briefs: Brief[]): Promise<{ batchId: string; itemIds: string[] }> {
    if (!briefs.length || briefs.length > 500) throw new BadRequestException('1-500 briefs per batch');
    const batchId = randomUUID();
    const ids: string[] = [];
    for (const brief of briefs) {
      const item: Item = { id: randomUUID(), batchId, brief, status: 'queued', draft: null, finalText: null, score: null,
        attempts: 0, reviewer: null, reviewNote: null, history: [{ at: new Date().toISOString(), from: null, to: 'queued', by: 'system' }] };
      this.items.set(item.id, item);
      ids.push(item.id);
      await this.queue.add(item.id);
    }
    return { batchId, itemIds: ids };
  }

  /** Worker: generate → score → route. Idempotent: a redelivered job for a finished item does nothing. */
  async work(id: string, attempt: number, feedback?: string) {
    const item = this.items.get(id);
    if (!item || (item.status !== 'queued' && item.status !== 'generating')) return;
    if (item.status === 'queued') transition(item, 'generating', 'worker');
    item.attempts = attempt;
    try {
      item.draft = await generate(this.client, item.brief, feedback ?? item.reviewNote ?? undefined);
      item.score = await score(this.client, item.brief, item.draft);
      transition(item, 'scored', 'worker');
      const decision = route(item, this.policy, this.rand);
      transition(item, decision, 'router');
      if (decision === 'auto_approved') item.finalText = item.draft;
    } catch (e) {
      if (attempt >= 4) transition(item, 'failed', 'worker');
      throw e; // let the queue retry with backoff
    }
  }

  reviewQueue() {
    return [...this.items.values()].filter((i) => i.status === 'in_review')
      .sort((a, b) => (a.score?.total ?? 0) - (b.score?.total ?? 0)); // worst first
  }

  get(id: string) {
    const i = this.items.get(id);
    if (!i) throw new NotFoundException();
    return i;
  }

  async review(id: string, reviewer: string, decision: 'approve' | 'reject' | 'revise', opts: { editedText?: string; note?: string }) {
    const item = this.get(id);
    if (item.status !== 'in_review') throw new ConflictException(`item is ${item.status}`);
    item.reviewer = reviewer;
    if (decision === 'approve') {
      item.finalText = opts.editedText?.trim() || item.draft;
      transition(item, 'approved', reviewer);
    } else if (decision === 'reject') {
      item.reviewNote = opts.note ?? null;
      transition(item, 'rejected', reviewer);
    } else {
      if (!opts.note || opts.note.trim().length < 5) throw new BadRequestException('revision needs a note for the writer model');
      item.reviewNote = opts.note.trim();
      transition(item, 'queued', reviewer);
      await this.queue.add(item.id, { priority: 1 });
    }
    return item;
  }

  publish(id: string, by: string) {
    const item = this.get(id);
    if (item.status !== 'approved' && item.status !== 'auto_approved') throw new ConflictException(`item is ${item.status}`);
    return transition(item, 'published', by);
  }

  /** Reviewer agreement on the auto-approve QA sample: the number that justifies the threshold. */
  metrics() {
    const all = [...this.items.values()];
    const by = (s: string) => all.filter((i) => i.status === s).length;
    const sampled = all.filter((i) => i.history.some((h) => h.by === 'router' && h.to === 'in_review') && i.score && i.score.total >= this.policy.autoApproveAt && i.score.claims === 1 && i.score.facts === 1);
    const sampledDecided = sampled.filter((i) => i.status === 'approved' || i.status === 'rejected' || i.status === 'published');
    const sampleApproved = sampledDecided.filter((i) => i.history.some((h) => h.to === 'approved')).length;
    return {
      total: all.length, published: by('published'), inReview: by('in_review'), autoApproved: by('auto_approved'), failed: by('failed'),
      autoApprovePrecision: sampledDecided.length ? sampleApproved / sampledDecided.length : null,
    };
  }
}
