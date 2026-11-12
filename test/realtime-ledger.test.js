import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createCareerService } from '../src/domain/index.js';
import { CAREER_MIGRATIONS, openStore } from '../src/domain/store.js';

const root = path.resolve(process.env.ZHIJING_TEST_ROOT ?? fileURLToPath(new URL('../.runtime/tests/', import.meta.url)), 'realtime-ledger');
function directory(t, beforeCleanup = () => {}) {
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  t.after(async () => { await beforeCleanup(); assert.equal(path.dirname(dir), path.resolve(root)); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
async function fixture(t) {
  let service;
  const dir = directory(t, () => service?.close());
  service = createCareerService({ directory: dir, generate: () => { throw new Error('No model calls allowed'); } });
  const resume = await service.dispatch('material.add', { kind: 'resume', title: '合成简历', text: '我整理过访谈资料。' });
  const job = await service.dispatch('material.add', { kind: 'job', title: '合成岗位', text: '访谈及数据整理。' });
  await service.dispatch('material.confirm', { versionId: resume.latestVersionId });
  await service.dispatch('material.confirm', { versionId: job.latestVersionId });
  const goal = await service.dispatch('goal.create', { title: '合成产品岗位' });
  await service.dispatch('goal.linkMaterial', { goalId: goal.id, versionId: job.latestVersionId });
  await service.dispatch('conversation.link', { goalId: goal.id, versionId: resume.latestVersionId, sessionId: 'session-voice-test', kind: 'interview' });
  const value = service.realtime.create({ goalId: goal.id, versionId: resume.latestVersionId, sessionId: 'session-voice-test' });
  return { dir, service, value, ledger: service.realtime };
}
test('provider transcript ledger is immutable, idempotent and maps delayed human speech to its original question', async t => {
  const { ledger, value, service } = await fixture(t);
  const call = ledger.begin({ interviewId: value.id, provider: 'synthetic', model: 'protocol-test' });
  assert.throws(() => ledger.begin({ interviewId: value.id, provider: 'synthetic', model: 'protocol-test' }), { code: 'REALTIME_IN_USE' });
  const base = { callId: call.callId, epoch: call.epoch };
  const question = ledger.record({ ...base, key: 'response-1', role: 'assistant', text: '请讲一次访谈经历。' });
  ledger.record({ ...base, key: 'response-2', role: 'assistant', text: '你怎样核对结果？' });
  const input = { ...base, key: 'input-1', role: 'user', text: '我先听录音，再核对笔记。', questionId: question.questionId };
  const first = ledger.record(input), duplicate = ledger.record(input);
  assert.equal(first.id, duplicate.id); assert.equal(duplicate.duplicate, true);
  assert.throws(() => ledger.record({ ...input, text: '篡改' }), { code: 'REALTIME_EVENT_CONFLICT' });
  const state = (await service.dispatch('state')).interviews[0];
  assert.equal(state.questions[0].answer.text, input.text); assert.equal(state.questions[1].answer, null);
  assert.equal(ledger.pending(value.id).length, 3);
  ledger.markMirrored(first.id); assert.equal(ledger.pending(value.id).length, 2);
  assert.equal(ledger.entries(value.id).length, 3);
  assert(!JSON.stringify(ledger.entries(value.id)).includes('audioBase64'));
});
test('pause rejects late provider writes; review preserves raw input and revisions before reports', async t => {
  const { ledger, value, service } = await fixture(t);
  const call = ledger.begin({ interviewId: value.id, provider: 'synthetic', model: 'protocol-test' });
  const base = { callId: call.callId, epoch: call.epoch };
  const question = ledger.record({ ...base, key: 'response', role: 'assistant', text: '请回答。', interrupted: true });
  ledger.record({ ...base, key: 'input', role: 'user', text: '核对背记。', questionId: question.questionId });
  assert.throws(() => ledger.review({ interviewId: value.id }), { code: 'REALTIME_REVIEW_REQUIRES_PAUSE' });
  const paused = ledger.end({ ...base, reason: 'PAUSED' });
  assert.throws(() => ledger.record({ ...base, key: 'late', role: 'user', text: '迟到。' }), { code: 'REALTIME_CALL_CHANGED' });
  await assert.rejects(service.dispatch('interview.finish', { interviewId: value.id }), { code: 'REALTIME_REVIEW_REQUIRED' });
  const reviewed = ledger.review({ interviewId: value.id, revisions: [{ answerId: paused.questions[0].answer.id, text: '核对笔记。' }] });
  assert.equal(reviewed.voiceReviewed, true);
  assert.equal(reviewed.questions[0].answer.parts[0].text, '核对背记。');
  assert.equal(reviewed.questions[0].answer.text, '核对笔记。');
  assert.equal(reviewed.questions[0].answer.revisions[0].before, '核对背记。');
  assert.equal(ledger.entries(value.id)[1].text, '核对背记。');
});
test('restart pauses active call, keeps ledger and starts a new epoch without resending', async t => {
  const { dir, ledger, value, service } = await fixture(t);
  const first = ledger.begin({ interviewId: value.id, provider: 'synthetic', model: 'protocol-test' });
  ledger.record({ callId: first.callId, epoch: first.epoch, key: 'q', role: 'assistant', text: '保留原问题。' });
  await service.close();
  const restored = createCareerService({ directory: dir });
  try {
    assert.equal((await restored.dispatch('state')).interviews[0].status, 'paused');
    assert.equal(restored.realtime.entries(value.id).length, 1);
    const next = restored.realtime.begin({ interviewId: value.id, provider: 'synthetic', model: 'protocol-test' });
    assert.equal(next.epoch, first.epoch + 1);
  } finally { await restored.close(); }
});
test('real v2 database upgrades forward and failed v3 migration rolls back', t => {
  const prepare = dir => {
    const db = new DatabaseSync(path.join(dir, 'career.sqlite'));
    db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)');
    for (const migration of CAREER_MIGRATIONS.filter(item => item.version <= 2)) {
      db.exec(migration.sql); db.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(migration.version, 'fixture');
    }
    return db;
  };
  const dir = directory(t), db = prepare(dir); db.close();
  const migrated = openStore(dir);
  assert.equal(migrated.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 4); migrated.close();
  const failedDir = directory(t), conflicting = prepare(failedDir);
  conflicting.exec('CREATE TABLE realtime_events(id TEXT PRIMARY KEY)'); conflicting.close();
  assert.throws(() => openStore(failedDir));
  const inspect = new DatabaseSync(path.join(failedDir, 'career.sqlite'));
  try {
    assert.equal(inspect.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 2);
    assert.equal(inspect.prepare("SELECT name FROM sqlite_master WHERE name='realtime_calls'").get(), undefined);
  } finally { inspect.close(); }
});
