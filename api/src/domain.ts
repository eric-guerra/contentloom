// Content item lifecycle:
//   queued → generating → scored → (auto_approved | in_review) → approved/rejected → published
// Low-risk, high-scoring drafts skip review; everything else waits for a human.

export type Status = 'queued' | 'generating' | 'scored' | 'in_review' | 'auto_approved' | 'approved' | 'rejected' | 'published' | 'failed';

export interface Brief {
  sku: string;
  locale: 'en-US' | 'es-US' | 'fr-CA';
  facts: Record<string, string>;
  mustMention: string[];
  banned: string[];
  category: string;
}

export interface Score { facts: number; claims: number; length: number; judge: number | null; total: number; notes: string[] }

export interface Item {
  id: string;
  batchId: string;
  brief: Brief;
  status: Status;
  draft: string | null;
  finalText: string | null;
  score: Score | null;
  attempts: number;
  reviewer: string | null;
  reviewNote: string | null;
  history: { at: string; from: Status | null; to: Status; by: string }[];
}

const NEXT: Record<Status, Status[]> = {
  queued: ['generating', 'failed'],
  generating: ['scored', 'queued', 'failed'],
  scored: ['auto_approved', 'in_review'],
  in_review: ['approved', 'rejected', 'queued'],
  auto_approved: ['published', 'in_review'],
  approved: ['published'],
  rejected: ['queued'],
  published: [],
  failed: ['queued'],
};

export function transition(item: Item, to: Status, by: string, now = new Date()): Item {
  if (!NEXT[item.status].includes(to)) throw new Error(`${item.id}: ${item.status} → ${to} not allowed`);
  item.history.push({ at: now.toISOString(), from: item.status, to, by });
  item.status = to;
  return item;
}

/** Categories where a human always reviews (regulated or high-return-rate). */
export const ALWAYS_REVIEW = new Set(['baby', 'supplements', 'electrical']);

export interface RoutingPolicy { autoApproveAt: number; sampleRate: number }

/**
 * Route a scored draft. `rand` makes the QA sample deterministic in tests: a fraction of auto-approvable
 * drafts still goes to review, so reviewers keep measuring the auto-approve precision.
 */
export function route(item: Item, policy: RoutingPolicy, rand: () => number): 'auto_approved' | 'in_review' {
  const s = item.score!;
  if (ALWAYS_REVIEW.has(item.brief.category)) return 'in_review';
  if (s.claims < 1 || s.facts < 1) return 'in_review';
  if (s.judge === null) return 'in_review';
  if (s.total < policy.autoApproveAt) return 'in_review';
  return rand() < policy.sampleRate ? 'in_review' : 'auto_approved';
}
