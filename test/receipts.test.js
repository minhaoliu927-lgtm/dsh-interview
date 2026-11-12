import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createCareerService } from '../src/domain/index.js';
import { CAREER_MIGRATIONS, openStore } from '../src/domain/store.js';
const root = path.resolve(process.env.ZHIJING_TEST_ROOT ? path.join(process.env.ZHIJING_TEST_ROOT, 'receipts') : fileURLToPath(new URL('../.runtime/tests/receipts/', import.meta.url)));
function directory(t) {
  fs.mkdirSync(root, { recursive: true }); const dir = fs.mkdtempSync(path.join(root, 'case-'));
  t.after(() => { assert.equal(path.dirname(dir), path.resolve(root)); fs.rmSync(dir, { recursive: true, force: true }); }); return dir;
}
function fixture(t) {
  fs.mkdirSync(root, { recursive: true }); const dir = fs.mkdtempSync(path.join(root, 'case-'));
  const service = createCareerService({ directory: dir });
  t.after(async () => { await service.close(); assert.equal(path.dirname(dir), path.resolve(root)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, service, call: service.dispatch };
}
test('undo creates an unconfirmed restoration version and never alters frozen conversation evidence', async t => {
  const { call, service, dir } = fixture(t);
  const original = await call('material.add', { title: 'Original', kind: 'resume', text: 'Original facts.' });
  await call('material.confirm', { versionId: original.latestVersionId });
  const goal = await call('goal.create', { title: 'Engineer' });
  await call('conversation.link', { goalId: goal.id, sessionId: 'synthetic-receipt', kind: 'chat', versionId: original.latestVersionId });
  const frozen = await call('conversation.context', { sessionId: 'synthetic-receipt' });
  const update = await call('material.update', { materialId: original.id, title: 'Edited', text: 'Reordered facts.' });
  assert.equal(update.receipt.undo.available, true);
  const undone = await call('receipt.undo', { receiptId: update.receipt.id });
  const state = await call('state'), restored = state.materials[0];
  assert.equal(restored.versions.length, 3); assert.equal(restored.title, 'Original');
  assert.equal(restored.versions[0].text, 'Original facts.'); assert.equal(restored.versions[0].confirmed, false);
  assert.equal(restored.versions[1].id, update.latestVersionId); assert.equal(restored.versions[2].confirmed, true);
  assert.deepEqual(await call('conversation.context', { sessionId: 'synthetic-receipt' }), frozen);
  assert.equal(undone.receipt.target.versionId, restored.latestVersionId);
  await assert.rejects(call('receipt.undo', { receiptId: update.receipt.id }), { code: 'UNDO_USED' });
  await service.close(); const reopened = createCareerService({ directory: dir });
  try { assert.deepEqual((await reopened.dispatch('state')).receipts, state.receipts); } finally { await reopened.close(); }
});
test('stale edits are not undoable and failed undo makes no partial changes', async t => {
  const { call } = fixture(t);
  const row = await call('material.add', { title: 'Resume', kind: 'resume', text: 'A' });
  const first = await call('material.update', { materialId: row.id, text: 'B' });
  await call('material.update', { materialId: row.id, text: 'C' });
  const before = await call('state');
  assert.equal(before.receipts.find(r => r.id === first.receipt.id).undo.reasonCode, 'UNDO_CONFLICT');
  await assert.rejects(call('receipt.undo', { receiptId: first.receipt.id }), { code: 'UNDO_CONFLICT' });
  assert.deepEqual(await call('state'), before);
});
test('goal undo restores only changed fields and refuses conflicting changes', async t => {
  const { call } = fixture(t), goal = await call('goal.create', { title: 'Engineer', company: 'A' });
  const title = await call('goal.update', { goalId: goal.id, title: 'Designer' });
  await call('goal.update', { goalId: goal.id, company: 'B' });
  await call('receipt.undo', { receiptId: title.receipt.id });
  assert.equal((await call('state')).goals[0].title, 'Engineer');
  assert.equal((await call('state')).goals[0].company, 'B');
  const next = await call('goal.update', { goalId: goal.id, title: 'Writer' });
  await call('goal.update', { goalId: goal.id, title: 'Researcher' });
  await assert.rejects(call('receipt.undo', { receiptId: next.receipt.id }), { code: 'UNDO_CONFLICT' });
});
test('undo restores previous goal binding while keeping old conversations immutable', async t => {
  const { call } = fixture(t), goal = await call('goal.create', { title: 'Analyst' });
  const a = await call('material.add', { title: 'A', kind: 'job', text: 'A role' }), b = await call('material.add', { title: 'B', kind: 'job', text: 'B role' });
  for (const row of [a, b]) await call('material.confirm', { versionId: row.latestVersionId });
  await call('goal.linkMaterial', { goalId: goal.id, versionId: a.latestVersionId });
  await call('conversation.link', { goalId: goal.id, sessionId: 'binding-test', kind: 'chat' });
  const link = await call('goal.linkMaterial', { goalId: goal.id, versionId: b.latestVersionId });
  await call('receipt.undo', { receiptId: link.receipt.id });
  assert.equal((await call('state')).goals[0].materialLinks[0].versionId, a.latestVersionId);
  assert.equal((await call('conversation.context', { sessionId: 'binding-test' })).materials[0].id, a.latestVersionId);
  await assert.rejects(call('receipt.undo', { receiptId: goal.receipt.id }), { code: 'UNDO_CONFLICT' });
});
test('creation undo archives a still-empty goal; no history is deleted', async t => {
  const { call } = fixture(t), goal = await call('goal.create', { title: 'Test' });
  await call('receipt.undo', { receiptId: goal.receipt.id });
  const state = await call('state'); assert.equal(state.goals.length, 1); assert.equal(state.goals[0].status, 'archived');
});
test('schema 4 upgrades a real v3 database and rolls back a conflicting migration', t => {
  for (const conflict of [false, true]) {
    const dir = directory(t), db = new DatabaseSync(path.join(dir, 'career.sqlite'));
    db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)');
    for (const migration of CAREER_MIGRATIONS.filter(row => row.version <= 3)) { db.exec(migration.sql); db.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(migration.version, 'synthetic'); }
    if (conflict) db.exec('CREATE TABLE operation_receipts(id TEXT PRIMARY KEY)'); db.close();
    if (conflict) assert.throws(() => openStore(dir)); else { const store = openStore(dir); store.close(); const again = openStore(dir); again.close(); }
    const inspect = new DatabaseSync(path.join(dir, 'career.sqlite'));
    assert.equal(inspect.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, conflict ? 3 : 4);
    if (conflict) assert.equal(inspect.prepare("SELECT name FROM sqlite_master WHERE name='operation_receipts_created'").get(), undefined);
    inspect.close(); assert.equal(fs.existsSync(path.join(dir, 'career.sqlite.owner')), false);
  }
});

test('object sessions persist after restart and refuse a different material or target role', async t => {
  const { call, service, dir } = fixture(t);
  const source = await call('material.add', { title: 'Company notes', kind: 'company', text: 'Synthetic public company notes.' });
  const other = await call('material.add', { title: 'Other', kind: 'company', text: 'Different notes.' });
  await call('material.confirm', { versionId: source.latestVersionId });
  await call('conversation.link', { sessionId: 'object-company', kind: 'chat', contextVersionId: source.latestVersionId });
  await call('conversation.bindObject', { kind: 'material', id: source.id, sessionId: 'object-company' });
  await assert.rejects(call('conversation.bindObject', { kind: 'material', id: other.id, sessionId: 'object-company' }), { code: 'CONVERSATION_CONTEXT_MISMATCH' });
  const role = await call('goal.create', { title: 'Different role' });
  await assert.rejects(call('conversation.bindObject', { kind: 'goal', id: role.id, sessionId: 'object-company' }), { code: 'CONVERSATION_CONTEXT_MISMATCH' });
  await assert.rejects(call('conversation.link', { sessionId: 'unconfirmed', kind: 'chat', contextVersionId: other.latestVersionId }), { code: 'MATERIAL_NOT_CONFIRMED' });
  const saved = (await call('state')).deskConversations; await service.close();
  const reopened = createCareerService({ directory: dir });
  try { assert.deepEqual((await reopened.dispatch('state')).deskConversations, saved); } finally { await reopened.close(); }
});
