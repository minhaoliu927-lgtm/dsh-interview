import test from 'node:test';
import assert from 'node:assert/strict';
import { appendNativeDraft, contextDraft, materialChatContext } from '../client/desk-context.js';
import { en } from '../locale/dictionaries.js';

const t = (key, values = {}) => String(en[key] || key).replace(/\{([^}]+)\}/g, (_, name) => values[name] ?? name);
const version = { id: 'old-confirmed', revision: 1, confirmed: true, text: 'Original\r\n项目😀\r\nUnchanged' };
const state = { materials: [{ id: 'resume', kind: 'resume', title: 'My resume', latestVersionId: 'new-draft',
  versions: [{ id: 'new-draft', revision: 2, confirmed: false, text: 'Not reviewed' }, version] }] };

test('assistant citations use the explicitly selected immutable version, not the newest version', () => {
  const context = materialChatContext(state, version.id);
  assert.equal(context.text, version.text); assert.equal(context.revision, 1);
  assert.match(contextDraft(context, t), /old-confirmed/);
  assert.equal(materialChatContext(state, 'new-draft'), null); assert.equal(materialChatContext(state, 'missing'), null);
  assert.equal(version.text, 'Original\r\n项目😀\r\nUnchanged');
});

test('selected passages reject stale versions, forged contents and invalid offsets without truncating Unicode', () => {
  const start = version.text.indexOf('项目'), end = start + '项目😀'.length;
  const passage = { versionId: version.id, start, end, text: '项目😀' };
  assert.equal(materialChatContext(state, version.id, passage).text, '项目😀');
  for (const patch of [{ versionId: 'another' }, { text: 'invented' }, { start: -1 }, { end: 999 }, { start: 1.1 }])
    assert.equal(materialChatContext(state, version.id, { ...passage, ...patch }), null);
});

test('native draft preparation holds the exact Session binding and appends without submitting or replacing attachments', async () => {
  const binding = { sessionId: 's1', session: { prompt() { assert.fail('No automatic send'); } } };
  let held = false, released = false, draft = 'Existing user draft'; const attachments = ['attachment-1'];
  const sessions = { async using(id, options, callback) {
    assert.equal(id, 's1'); assert.equal(options.source, 'zhijingChat'); held = true;
    try { return await callback({ ready: Promise.resolve(binding) }); } finally { held = false; released = true; }
  } };
  const conversation = { input: { requestDraftInitialization(actual, options) {
    assert.equal(actual, binding); assert(held); assert.equal(options.whenDraftExists, 'append');
    assert.equal(options.clearPreviousDraft, undefined); draft += '\n\n' + options.prompt; return 'applied';
  } } };
  assert.equal(await appendNativeDraft(sessions, conversation, 's1', 'Selected source'), 'applied');
  assert.equal(draft, 'Existing user draft\n\nSelected source'); assert.deepEqual(attachments, ['attachment-1']); assert(released);
});

test('busy or unavailable native draft capabilities fail without fallback HTTP or model submission', async () => {
  const sessions = { async using(id, options, callback) { return callback({ ready: Promise.resolve({ sessionId: id }) }); } };
  for (const result of ['blocked', 'preserved']) await assert.rejects(appendNativeDraft(sessions,
    { input: { requestDraftInitialization: () => result } }, 's1', 'source'), error => error.code === 'NATIVE_DRAFT_BLOCKED');
  await assert.rejects(appendNativeDraft(sessions, {}, 's1', 'source'), error => error.code === 'NATIVE_DRAFT_UNAVAILABLE');
});
