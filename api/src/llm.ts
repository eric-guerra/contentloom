import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Brief, Score } from './domain';

export const MODEL = 'claude-opus-5-5';

type Client = Pick<Anthropic, 'beta'>;

const COMMON = {
  model: MODEL,
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default' as const,
};

const LOCALE_NAME: Record<Brief['locale'], string> = { 'en-US': 'US English', 'es-US': 'US Spanish', 'fr-CA': 'Canadian French' };

export function generationSystem(locale: Brief['locale']) {
  return `You write product descriptions for a home-goods retailer, in ${LOCALE_NAME[locale]}. Write 50-90 words in a warm, \
practical voice. Use only the facts given; state material and dimensions exactly as provided. Don't make claims the facts don't \
support, and avoid superlatives and exclamation marks. Return only the description text.`;
}

export async function generate(client: Client, brief: Brief, feedback?: string): Promise<string> {
  const facts = Object.entries(brief.facts).map(([k, v]) => `${k}: ${v}`).join('\n');
  const res = await client.beta.messages.create({
    ...COMMON,
    max_tokens: 2000,
    system: generationSystem(brief.locale),
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: feedback ? `${facts}\n\nA reviewer asked for changes to the previous draft: ${feedback}` : facts }],
  });
  if (res.stop_reason === 'refusal') throw new Error('generation declined');
  return res.content.filter((b) => b.type === 'text').map((b: any) => b.text).join('').trim();
}

const Verdict = z.object({
  rationale: z.string(),
  accuracy: z.number().int().min(1).max(5),
  usefulness: z.number().int().min(1).max(5),
  tone: z.number().int().min(1).max(5),
});

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    rationale: { type: 'string', description: 'Two sentences, written before the scores' },
    accuracy: { type: 'integer', description: '1-5: every claim supported by the facts' },
    usefulness: { type: 'integer', description: '1-5: helps a shopper decide' },
    tone: { type: 'integer', description: '1-5: warm and practical, no hype' },
  },
  required: ['rationale', 'accuracy', 'usefulness', 'tone'],
  additionalProperties: false,
};

/** LLM judge via structured output (JSON schema on output_config.format). Returns null if no verdict. */
export async function judge(client: Client, brief: Brief, draft: string): Promise<z.infer<typeof Verdict> | null> {
  const res = await client.beta.messages.create({
    ...COMMON,
    max_tokens: 2000,
    system: 'You grade product descriptions against the product facts. Be strict about accuracy: any claim not in the facts caps accuracy at 2.',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
    messages: [{ role: 'user', content: `Facts:\n${Object.entries(brief.facts).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n<description>\n${draft}\n</description>` }],
  });
  if (res.stop_reason !== 'end_turn') return null;
  const text = res.content.filter((b) => b.type === 'text').map((b: any) => b.text).join('');
  const parsed = Verdict.safeParse(JSON.parse(text));
  return parsed.success ? parsed.data : null;
}

/** Deterministic checks first; the judge only adds what code can't check. */
export function deterministicScore(brief: Brief, draft: string): Omit<Score, 'judge' | 'total'> {
  const low = draft.toLowerCase().replace(/\s+/g, ' ');
  const missing = brief.mustMention.filter((m) => !low.includes(m.toLowerCase()));
  const banned = brief.banned.filter((b) => new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(draft));
  const words = draft.split(/\s+/).filter(Boolean).length;
  const notes = [
    ...missing.map((m) => `missing "${m}"`),
    ...banned.map((b) => `banned claim "${b}"`),
    ...(words < 40 || words > 120 ? [`${words} words`] : []),
  ];
  return {
    facts: brief.mustMention.length ? 1 - missing.length / brief.mustMention.length : 1,
    claims: banned.length ? 0 : 1,
    length: words >= 40 && words <= 120 ? 1 : 0,
    notes,
  };
}

export async function score(client: Client, brief: Brief, draft: string): Promise<Score> {
  const d = deterministicScore(brief, draft);
  const v = await judge(client, brief, draft);
  const judgeScore = v ? ((v.accuracy - 1) * 2 + (v.usefulness - 1) + (v.tone - 1)) / 16 : null;
  const total = judgeScore === null ? 0 : Math.round((0.25 * d.facts + 0.25 * d.claims + 0.1 * d.length + 0.4 * judgeScore) * 1000) / 1000;
  return { ...d, judge: judgeScore, total, notes: v ? [...d.notes, `judge: ${v.rationale}`] : [...d.notes, 'judge: no verdict'] };
}
