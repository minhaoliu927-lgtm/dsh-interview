import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionRows, filterCollection, DESK_PAGES } from '../client/desk-collections.js';
test('collections filter real content without mutating source order, and keep deterministic sorting', () => {
  const rows = [{ id: 'a', title: 'Beta', description: 'Data verification', category: 'resume', createdAt: '2026-11-11' }, { id: 'b', title: 'Alpha', description: 'Research', category: 'job', createdAt: '2026-11-12' }];
  assert.deepEqual(filterCollection(rows).map(r => r.id), ['b', 'a']);
  assert.deepEqual(filterCollection(rows, { query: 'VERIFICATION' }).map(r => r.id), ['a']);
  assert.deepEqual(filterCollection(rows, { query: 'Research', filter: 'resume' }), []);
  assert.deepEqual(filterCollection(rows, { sort: 'title' }).map(r => r.id), ['b', 'a']);
  assert.deepEqual(rows.map(r => r.id), ['a', 'b']);
});
test('personal and results collections preserve immutable version identities and native titles', () => {
  const state = { materials: [{ id: 'm', title: 'Resume', kind: 'resume', latestVersionId: 'v2', versions: [{ id: 'v1', text: 'old' }, { id: 'v2', text: 'new' }] }], goals: [], interviews: [], reports: [], assessments: [{ id: 'a', kind: 'resume', versionId: 'v1' }], rewrites: [], conversations: [{ id: 'c', title: 'Old title', kind: 'chat', sessionId: 'session' }] };
  assert.equal(collectionRows(state, 'personal')[0].versionId, 'v2');
  assert.equal(collectionRows(state, 'personal')[0].description, 'new');
  assert.equal(collectionRows(state, 'reports')[0].versionId, 'v1');
  assert.equal(collectionRows(state, 'home', { session: { title: 'Native title' } })[0].title, 'Native title');
  assert.equal(DESK_PAGES.length, 5);
});
