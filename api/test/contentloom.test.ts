import 'reflect-metadata';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { MemoryQueue } from '../src/queue';
import { ContentService } from '../src/service';
import { deterministicScore, MODEL } from '../src/llm';

/** Fake Anthropic client. Generation echoes facts into a description; the judge returns scripted grades. */
function fakeClient() {
  const calls: any[] = [];
  const state = { judge: { accuracy: 5, usefulness: 5, tone: 5 }, failNextGenerations: 0, generatorAddsClaim: '' };
  const client = {
    beta: {
      messages: {
        create: async (req: any) => {
          calls.push(req);
          if (req.output_config?.format) {
            return { stop_reason: 'end_turn', model: MODEL, content: [{ type: 'text', text: JSON.stringify({ rationale: 'ok', ...state.judge }) }] };
          }
          if (state.failNextGenerations > 0) { state.failNextGenerations--; throw new Error('529 overloaded'); }
          const facts = Object.fromEntries(req.messages[0].content.split('\n').filter((l: string) => l.includes(': ')).map((l: string) => l.split(': ')));
          const text = `Meet the ${facts.name}, made from ${facts.material} and measuring ${facts.size}. It is easy to live with and suits most rooms, `
            + `bringing quiet texture to everyday spaces without demanding attention. Care is simple: ${facts.care}. ${state.generatorAddsClaim}`
            + `A practical choice for daily use that should look good for years with very little effort from you.`;
          return { stop_reason: 'end_turn', model: MODEL, content: [{ type: 'text', text }] };
        },
      },
    },
  };
  return { client, calls, state };
}

const brief = (sku: string, category = 'textiles') => ({
  sku, locale: 'en-US', category,
  facts: { name: `Sage Throw ${sku}`, material: 'cotton', size: '50 x 60 in', care: 'machine wash cold' },
  mustMention: ['cotton', '50 x 60 in'], banned: ['waterproof'],
});

const EDITOR = { 'x-user': 'ed', 'x-roles': 'editor' };
const REVIEWER = { 'x-user': 'rita', 'x-roles': 'reviewer' };
const PUBLISHER = { 'x-user': 'pat', 'x-roles': 'publisher' };

let app: INestApplication, http: any, queue: MemoryQueue, fake: ReturnType<typeof fakeClient>, svc: ContentService, rolls: number[];

beforeEach(async () => {
  fake = fakeClient();
  queue = new MemoryQueue();
  rolls = [];
  const mod = await Test.createTestingModule({
    imports: [AppModule.forRoot({ client: fake.client, queue, policy: { autoApproveAt: 0.85, sampleRate: 0.1 }, random: () => rolls.shift() ?? 0.99 })],
  }).compile();
  app = mod.createNestApplication();
  await app.init();
  http = app.getHttpServer();
  svc = app.get(ContentService);
});

after(async () => app?.close());

test('high-scoring drafts auto-approve and publish; requests are well-formed', async () => {
  const r = await request(http).post('/batches').set(EDITOR).send({ briefs: [brief('A1'), brief('A2')] });
  assert.equal(r.status, 201);
  await queue.drain();
  const items = r.body.itemIds.map((id: string) => svc.get(id));
  assert.deepEqual(items.map((i: any) => i.status), ['auto_approved', 'auto_approved']);
  assert.equal(items[0].score.total, 1);
  const gen = fake.calls.find((c) => !c.output_config.format);
  const jdg = fake.calls.find((c) => c.output_config.format);
  assert.equal(gen.model, 'claude-opus-5-5');
  assert.equal(gen.fallbacks, 'default');
  assert.equal(jdg.output_config.format.type, 'json_schema');
  assert.equal(jdg.output_config.format.schema.additionalProperties, false);
  assert.equal((await request(http).post(`/items/${items[0].id}/publish`).set(PUBLISHER)).body.status, 'published');
});

test('banned claims, regulated categories and the QA sample go to human review', async () => {
  fake.state.generatorAddsClaim = 'It is fully waterproof. ';
  const a = await request(http).post('/batches').set(EDITOR).send({ briefs: [brief('B1')] });
  await queue.drain(); // generation happens on drain, so set per-batch behaviour before each one
  fake.state.generatorAddsClaim = '';
  const b = await request(http).post('/batches').set(EDITOR).send({ briefs: [brief('B2', 'baby')] });
  await queue.drain();
  rolls = [0.05]; // falls inside the 10% QA sample
  const c = await request(http).post('/batches').set(EDITOR).send({ briefs: [brief('B3')] });
  await queue.drain();
  for (const r of [a, b, c]) assert.equal(svc.get(r.body.itemIds[0]).status, 'in_review');
  assert.match(svc.get(a.body.itemIds[0]).score!.notes.join(' '), /banned claim "waterproof"/);
  const reviewQ = (await request(http).get('/review').set(REVIEWER)).body;
  assert.equal(reviewQ[0].brief.sku, 'B1', 'worst-scoring first');
});

test('reviewer edits, approves, asks for revisions; the revision note reaches the writer', async () => {
  fake.state.judge = { accuracy: 3, usefulness: 3, tone: 3 };
  const r = await request(http).post('/batches').set(EDITOR).send({ briefs: [brief('C1'), brief('C2')] });
  await queue.drain();
  const [i1, i2] = r.body.itemIds;
  assert.equal(svc.get(i1).status, 'in_review');

  const approved = await request(http).post(`/items/${i1}/review`).set(REVIEWER).send({ decision: 'approve', editedText: 'A hand-edited description.' });
  assert.equal(approved.body.finalText, 'A hand-edited description.');

  assert.equal((await request(http).post(`/items/${i2}/review`).set(REVIEWER).send({ decision: 'revise' })).status, 400);
  fake.state.judge = { accuracy: 5, usefulness: 5, tone: 5 };
  await request(http).post(`/items/${i2}/review`).set(REVIEWER).send({ decision: 'revise', note: 'Mention it is pre-washed' });
  await queue.drain();
  const lastGen = fake.calls.filter((c) => !c.output_config.format).at(-1);
  assert.match(lastGen.messages[0].content, /reviewer asked for changes.*pre-washed/);
  assert.equal(svc.get(i2).status, 'auto_approved');
});

test('transient model errors retry; permanent failure is recorded', async () => {
  fake.state.failNextGenerations = 2;
  const ok = await request(http).post('/batches').set(EDITOR).send({ briefs: [brief('D1')] });
  await queue.drain();
  assert.equal(svc.get(ok.body.itemIds[0]).status, 'auto_approved');
  assert.equal(svc.get(ok.body.itemIds[0]).attempts, 3);

  fake.state.failNextGenerations = 10;
  const bad = await request(http).post('/batches').set(EDITOR).send({ briefs: [brief('D2')] });
  await queue.drain();
  assert.equal(svc.get(bad.body.itemIds[0]).status, 'failed');
});

test('roles, validation and lifecycle guards', async () => {
  assert.equal((await request(http).post('/batches').set(REVIEWER).send({ briefs: [brief('E1')] })).status, 401);
  assert.equal((await request(http).post('/batches').set(EDITOR).send({ briefs: [{ ...brief('E2'), locale: 'de-DE' }] })).status, 400);
  const r = await request(http).post('/batches').set(EDITOR).send({ briefs: [brief('E3')] });
  assert.equal((await request(http).post(`/items/${r.body.itemIds[0]}/publish`).set(PUBLISHER)).status, 409, 'not generated yet');
  await queue.drain();
  assert.equal((await request(http).post(`/items/${r.body.itemIds[0]}/review`).set(REVIEWER).send({ decision: 'approve' })).status, 409, 'not in review');
});

test('metrics track auto-approve precision from the QA sample', async () => {
  rolls = [0.01, 0.02];
  const r = await request(http).post('/batches').set(EDITOR).send({ briefs: [brief('F1'), brief('F2')] });
  await queue.drain();
  await request(http).post(`/items/${r.body.itemIds[0]}/review`).set(REVIEWER).send({ decision: 'approve' });
  await request(http).post(`/items/${r.body.itemIds[1]}/review`).set(REVIEWER).send({ decision: 'reject', note: 'too generic' });
  const m = (await request(http).get('/metrics')).body;
  assert.equal(m.autoApprovePrecision, 0.5);
});

test('deterministic score', () => {
  const s = deterministicScore(brief('G1') as any, 'cotton throw, waterproof');
  assert.deepEqual([s.facts, s.claims, s.length], [0.5, 0, 0]);
});
